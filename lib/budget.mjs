export const CAP_NANO = 5_000_000_000;
export const RESERVATION_NANO = 250_000_000;
export function budgetMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}`;
}
export function budgetStore(db) {
  return {
    get: (id) =>
      db.prepare("SELECT * FROM extractions WHERE id = ?").bind(id).first(),
    async baseline(month, cost) {
      if (
        !/^\d{4}-\d{2}$/.test(month) ||
        !Number.isSafeInteger(cost) ||
        cost < 0 ||
        cost > CAP_NANO
      )
        throw new Error("baseline");
      await db
        .prepare(
          "INSERT OR IGNORE INTO extractions (id,month,state,reserved_nano,cost_nano,created_at,note) VALUES (?,?,'accounted',0,?,?,?)",
        )
        .bind(
          `prior-local-${month}`,
          month,
          cost,
          new Date().toISOString(),
          "Prior local API usage; invoice reconciliation pending",
        )
        .run();
    },
    async reserve(id, month) {
      // One SQLite write statement serializes the budget predicate and unique claim.
      // Unresolved older requests continue consuming capacity across month boundaries.
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO extractions (id,month,state,reserved_nano,created_at)
        SELECT ?,?,'reserved',?,? WHERE
        COALESCE((SELECT SUM(COALESCE(cost_nano,reserved_nano)) FROM extractions WHERE month = ? OR state IN ('reserved','uncertain')),0) + ? <= ?`,
        )
        .bind(
          id,
          month,
          RESERVATION_NANO,
          new Date().toISOString(),
          month,
          RESERVATION_NANO,
          CAP_NANO,
        )
        .run();
      return result.meta.changes === 1;
    },
    async finish(
      id,
      {
        state,
        cost = null,
        usage = null,
        result = null,
        responseId = null,
        requestId = null,
        note = null,
      },
    ) {
      await db
        .prepare(
          `UPDATE extractions SET state=?,cost_nano=?,usage=?,result=?,response_id=?,request_id=?,note=? WHERE id=? AND state IN ('reserved','uncertain')`,
        )
        .bind(
          state,
          cost,
          usage ? JSON.stringify(usage) : null,
          result ? JSON.stringify(result) : null,
          responseId,
          requestId,
          note,
          id,
        )
        .run();
    },
  };
}

export function usageCost(response) {
  const u = response?.usage,
    d = u?.input_tokens_details;
  if (
    response?.model !== "gpt-6-luna" ||
    response?.service_tier !== "flex" ||
    !u ||
    !d
  )
    return null;
  const { input_tokens: input, output_tokens: output } = u;
  const { cached_tokens: cached, cache_write_tokens: writes } = d;
  if (
    ![input, output, cached, writes].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    cached + writes > input ||
    input > 120000 ||
    output > 12000 ||
    u.output_tokens_details?.reasoning_tokens !== 0
  )
    return null;
  // Flex / short context / explicit 30m cache. Rates verified 2026-11-11.
  const nano = Math.ceil(
    (input - cached - writes) * 50 + cached * 5 + writes * 62.5 + output * 250,
  );
  return nano <= RESERVATION_NANO ? nano : null;
}

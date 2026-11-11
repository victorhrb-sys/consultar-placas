import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { PDFDocument } from "pdf-lib";
import {
  budgetStore,
  budgetMonth,
  CAP_NANO,
  RESERVATION_NANO,
  usageCost,
} from "./lib/budget.mjs";
import {
  extractApi,
  responsePayload,
  validateExtraction,
} from "./lib/extraction.mjs";
import { extractText, groupPlates } from "./lib/plates.mjs";

const extraction = {
  paginas_analisadas: [1],
  registros: [
    { pagina: 1, hora: "12:00:00", placa: "ABC1D23", status: "completa" },
    { pagina: 1, hora: "12:10:00", placa: "ABC1D23", status: "completa" },
    { pagina: 1, hora: "", placa: "AB?1234", status: "parcial" },
  ],
  observacoes: "",
};
const apiResponse = (value) => ({
  id: "resp_test",
  model: "gpt-6-luna",
  service_tier: "flex",
  status: "completed",
  usage: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 900 },
    output_tokens: 100,
    output_tokens_details: { reasoning_tokens: 0 },
  },
  output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
});
async function database() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir(new URL("./drizzle/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL(`./drizzle/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((x) => x.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  return { db, ledger: budgetStore(db), close: () => mf.dispose() };
}
async function pdf(pages = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return doc.save();
}
const request = (bytes) =>
  new Request("https://site.test/api/extrair", {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      origin: "https://site.test",
      "oai-authenticated-user-id": "owner",
    },
    body: bytes,
  });
const config = (db) => ({
  DB: db,
  OPENAI_API_KEY: "test-secret",
  OPENAI_PRIOR_USAGE_MONTH: "2026-11",
  OPENAI_PRIOR_USAGE_NANO: "1000000",
});

test("texto: normaliza sem inferir, mantém origens, agrupa repetidas e separa parciais", () => {
  const value = extractText(
    "Passagem ABC-1234, ABC1D23\nABC1234; AB?1234; SEM LEITURA\nID XABC12345 DATA 2026-11",
  );
  const groups = groupPlates(value.registros);
  assert.equal(groups.plates.length, 2);
  assert.equal(groups.plates[0].ocorrencias.length, 2);
  assert.equal(groups.issues.length, 2);
  assert.equal(groups.plates[0].ocorrencias[1].linha, 2);
  assert.throws(() => extractText("A".repeat(100001)), /excede/);
});
test("validação rejeita omissão de página, saída truncada e placa inventada fora do formato", () => {
  assert.throws(() => validateExtraction(extraction, 2));
  assert.throws(() =>
    validateExtraction(
      {
        ...extraction,
        registros: [
          { pagina: 2, placa: "ABC1D23", status: "completa", hora: "" },
        ],
      },
      1,
    ),
  );
  assert.throws(() =>
    validateExtraction(
      {
        ...extraction,
        registros: [
          { pagina: 1, placa: "ABC123", status: "completa", hora: "" },
        ],
      },
      1,
    ),
  );
});
test("tarifa calcula um cenário sintético; configuração inesperada mantém reserva", () => {
  const response = apiResponse(extraction);
  response.usage = {
    input_tokens: 10000,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
    output_tokens: 2000,
    output_tokens_details: { reasoning_tokens: 0 },
  };
  assert.equal(usageCost(response), 1000000);
  assert.equal(usageCost({ ...response, service_tier: "default" }), null);
  assert.equal(usageCost({ ...response, model: "gpt-6-astra" }), null);
  assert.equal(budgetMonth(new Date("2026-12-01T01:00:00Z")), "2026-11");
});
test("D1 real: reservas concorrentes não ultrapassam US$ 5 e duplicatas só reservam uma vez", async () => {
  const s = await database();
  try {
    await s.ledger.baseline("2026-11", 1000000);
    const accepted = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        s.ledger.reserve(`document-${i}`, "2026-11"),
      ),
    );
    assert.equal(accepted.filter(Boolean).length, 19);
    const total = await s.db
      .prepare(
        "SELECT SUM(COALESCE(cost_nano,reserved_nano)) AS total FROM extractions",
      )
      .first();
    assert.ok(total.total <= CAP_NANO);
    assert.equal(await s.ledger.reserve("document-0", "2026-12"), false);
    // Older unresolved reservations consume next month's capacity too.
    assert.equal(await s.ledger.reserve("next-month", "2026-12"), true);
    assert.equal(await s.ledger.reserve("next-month-2", "2026-12"), false);
  } finally {
    await s.close();
  }
});
test("PDF: uma geração, payload fixo, cache por bytes, sem expor chave ou armazenar PDF", async () => {
  const s = await database();
  try {
    const bytes = await pdf();
    let paid = 0;
    let counts = 0;
    const upstream = async (url, options) => {
      assert.equal(options.redirect, "manual");
      const body = JSON.parse(options.body);
      if (url.endsWith("input_tokens")) {
        counts++;
        return Response.json({ input_tokens: 1000 });
      }
      paid++;
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(body.service_tier, "flex");
      assert.equal(body.reasoning.effort, "none");
      assert.equal(body.store, false);
      assert.equal(body.truncation, "disabled");
      assert.equal(body.max_output_tokens, 12000);
      assert.equal(
        body.input[0].content[0].file_data,
        responsePayload(bytes).input[0].content[0].file_data,
      );
      return Response.json(apiResponse(extraction));
    };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        extractApi(request(bytes), config(s.db), { upstream }),
      ),
    );
    assert.equal(responses.filter((r) => r.ok).length >= 1, true);
    assert.equal(paid, 1);
    assert.equal(counts, 1);
    const cached = await extractApi(request(bytes), config(s.db), {
      upstream: () => {
        throw new Error("must not call");
      },
    });
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).cached, true);
    const entry = await s.db
      .prepare("SELECT * FROM extractions WHERE state='ready'")
      .first();
    assert.equal(entry.cost_nano, 86250);
    assert.doesNotMatch(
      JSON.stringify(entry),
      /test-secret|application\/pdf|base64/,
    );
  } finally {
    await s.close();
  }
});
test("timeout conserva reserva e não repete; arquivo incompleto não libera placas", async () => {
  for (const failure of ["timeout", "incomplete", "tier"]) {
    const s = await database();
    try {
      const bytes = await pdf();
      let paid = 0;
      const upstream = async (url) => {
        if (url.endsWith("input_tokens"))
          return Response.json({ input_tokens: 1000 });
        paid++;
        if (failure === "timeout") throw new Error("timeout");
        const result = apiResponse(extraction);
        if (failure === "incomplete") result.status = "incomplete";
        if (failure === "tier") result.service_tier = "default";
        return Response.json(result);
      };
      const response = await extractApi(request(bytes), config(s.db), {
        upstream,
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).registros, undefined);
      await extractApi(request(bytes), config(s.db), { upstream });
      assert.equal(paid, 1);
      const entry = await s.db
        .prepare("SELECT * FROM extractions WHERE id NOT LIKE 'prior-local%'")
        .first();
      if (failure !== "incomplete") {
        assert.equal(entry.state, "uncertain");
        assert.equal(entry.cost_nano, null);
        assert.equal(entry.reserved_nano, RESERVATION_NANO);
      } else assert.equal(entry.state, "invalid");
    } finally {
      await s.close();
    }
  }
});
test("limites, identidade e origem bloqueiam antes de gerar", async () => {
  const s = await database();
  try {
    let paid = 0;
    const upstream = async (url) => {
      if (!url.endsWith("input_tokens")) paid++;
      return Response.json({ input_tokens: 120001 });
    };
    assert.equal(
      (await extractApi(request(await pdf(21)), config(s.db), { upstream }))
        .status,
      413,
    );
    assert.equal(
      (await extractApi(request(await pdf()), config(s.db), { upstream }))
        .status,
      413,
    );
    const anonymous = request(await pdf());
    anonymous.headers.delete("oai-authenticated-user-id");
    assert.equal(
      (await extractApi(anonymous, config(s.db), { upstream })).status,
      401,
    );
    const cross = request(await pdf());
    cross.headers.set("origin", "https://other.test");
    assert.equal(
      (await extractApi(cross, config(s.db), { upstream })).status,
      403,
    );
    assert.equal(paid, 0);
  } finally {
    await s.close();
  }
});

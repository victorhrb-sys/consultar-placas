const BASE = "https://vehicle-api.example/v3";
const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function apiRequest(path, token, upstream) {
  // Workers accepts manual/follow only. Never forward Authorization on redirects.
  const response = await upstream(BASE + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error("Redirecionamento bloqueado");
  const text = await response.text();
  if (text.length > 1048576) throw new Error("Resposta inválida");
  return {
    ok: response.ok,
    status: response.status,
    body: JSON.parse(text.replaceAll(token, "[REDACTED]")),
  };
}
// Protected by the Site's owner-only access boundary, including service access.
// This read-only check never calls a charged vehicle endpoint.
export async function statusApi(request, env, upstream = fetch) {
  if (request.method !== "GET")
    return json({ message: "Método não permitido." }, 405);
  if (!env.API_PLACAS_TOKEN)
    return json({ ok: false, message: "Chave não configurada." }, 503);
  try {
    const result = await apiRequest("/saldo", env.API_PLACAS_TOKEN, upstream);
    if (
      !result.ok ||
      result.body.error ||
      !Number.isInteger(result.body.saldo_centavos)
    )
      throw new Error("Saldo indisponível");
    if (
      result.body.produto !== "vehicle_basic" ||
      result.body.preco_consulta_centavos !== 3 ||
      result.body.saldo_centavos < 0
    )
      return json(
        {
          ok: false,
          message: "Preço ou produto alterado. Consultas bloqueadas.",
        },
        409,
      );
    return json({
      ok: true,
      consultas_disponiveis: Math.floor(result.body.saldo_centavos / 3),
    });
  } catch {
    return json({ ok: false, message: "Falha na comunicação com a API." }, 502);
  }
}
export async function consulta(request, env, upstream = fetch) {
  if (request.method !== "POST")
    return json({ message: "Método não permitido." }, 405);
  if (!request.headers.get("oai-authenticated-user-id"))
    return json({ message: "Entre na sua conta para consultar." }, 401);
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return json({ message: "Origem da solicitação não permitida." }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ message: "Formato inválido." }, 415);
  const raw = await request.text();
  if (raw.length > 1024)
    return json({ message: "Solicitação muito grande." }, 413);
  let plate;
  try {
    plate = JSON.parse(raw)?.placa;
  } catch {
    return json({ message: "Solicitação inválida." }, 400);
  }
  if (typeof plate !== "string")
    return json({ message: "Informe a placa." }, 400);
  plate = plate.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(plate))
    return json({ message: "Placa inválida. Use ABC1234 ou ABC1D23." }, 400);
  const token = env.API_PLACAS_TOKEN;
  if (!token)
    return json({ message: "A chave da API ainda não está configurada." }, 503);
  let charged = false;
  async function call(path) {
    return apiRequest(path, token, upstream);
  }
  try {
    const balance = await call("/saldo");
    if ([401, 403].includes(balance.status))
      return json(
        { message: "A API recusou a chave de acesso. Revise a configuração." },
        502,
      );
    if (
      !balance.ok ||
      balance.body.error ||
      !Number.isInteger(balance.body.saldo_centavos)
    )
      throw new Error("Saldo indisponível");
    if (
      balance.body.produto !== "vehicle_basic" ||
      balance.body.preco_consulta_centavos !== 3
    )
      return json(
        {
          message:
            "O produto ou preço da API mudou. Revise a configuração antes de consultar.",
        },
        409,
      );
    if (balance.body.saldo_centavos < 3)
      return json(
        { message: "Saldo insuficiente. Recarregue sua conta na API PLACAS." },
        402,
      );
    charged = true;
    const response = await call("/basico/" + plate);
    const block = response.body?.basico;
    if (
      !response.ok ||
      response.body.error !== false ||
      block?.error !== false ||
      !block.dados ||
      typeof block.dados !== "object" ||
      Array.isArray(block.dados) ||
      !Object.keys(block.dados).length
    ) {
      return json(
        {
          message:
            "A API não retornou dados válidos para esta placa. Confira a placa e o saldo antes de repetir.",
        },
        502,
      );
    }
    // The basic product includes extra fields; return only the requested scope.
    const dados = Object.fromEntries(
      ["marca", "modelo", "cor", "ano", "anoModelo"].map((key) => [
        key,
        block.dados[key] ?? null,
      ]),
    );
    return json({
      placa: plate,
      dados,
      consultadoEm: new Date().toISOString(),
    });
  } catch {
    return json(
      {
        message: charged
          ? "A consulta não pôde ser concluída. Pode ter ocorrido cobrança; confira o saldo antes de repetir."
          : "Não foi possível verificar o saldo da API. Nenhuma consulta de placa foi enviada.",
      },
      502,
    );
  }
}

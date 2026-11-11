import test from "node:test";
import assert from "node:assert/strict";
import { consulta, statusApi } from "./lib/consulta.mjs";
const env = { API_PLACAS_TOKEN: "test-secret" };
const request = (placa = "abc-1234", headers = {}) =>
  new Request("https://site.test/api/consulta", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://site.test",
      "oai-authenticated-user-id": "owner",
      ...headers,
    },
    body: JSON.stringify({ placa }),
  });
const saldo = {
  saldo_centavos: 100,
  preco_consulta_centavos: 3,
  produto: "vehicle_basic",
};
test("normaliza placa, valida saldo e retorna dados sem segredo", async () => {
  const calls = [];
  const response = await consulta(request(), env, async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "manual");
    return Response.json(
      calls.length === 1
        ? saldo
        : {
            error: false,
            basico: {
              error: false,
              dados: { marca: "Teste", modelo: "test-secret" },
            },
          },
    );
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, [
    "https://vehicle-api.example/v3/saldo",
    "https://vehicle-api.example/v3/basico/ABC1234",
  ]);
  const data = await response.json();
  assert.equal(data.placa, "ABC1234");
  assert.equal(data.dados.modelo, "[REDACTED]");
});
test("bloqueia placa inválida, acesso anônimo e origem externa antes da API", async () => {
  const noNetwork = () => {
    throw new Error("não chamar");
  };
  assert.equal((await consulta(request("../123"), env, noNetwork)).status, 400);
  assert.equal(
    (
      await consulta(
        request("ABC1234", { "oai-authenticated-user-id": "" }),
        env,
        noNetwork,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await consulta(
        request("ABC1234", { origin: "https://outro.test" }),
        env,
        noNetwork,
      )
    ).status,
    403,
  );
});
test("saldo insuficiente e preço alterado não consultam placa", async () => {
  for (const [change, status] of [
    [{ saldo_centavos: 0 }, 402],
    [{ preco_consulta_centavos: 5 }, 409],
  ]) {
    let count = 0;
    const res = await consulta(request(), env, async () => {
      count++;
      return Response.json({ ...saldo, ...change });
    });
    assert.equal(res.status, status);
    assert.equal(count, 1);
  }
});
test("falha após envio não repete e avisa sobre cobrança incerta", async () => {
  let count = 0;
  const res = await consulta(request(), env, async () => {
    count++;
    if (count === 1) return Response.json(saldo);
    throw new Error("timeout");
  });
  assert.equal(res.status, 502);
  assert.equal(count, 2);
  assert.match((await res.json()).message, /cobrança/);
});
test("resposta inválida e veículo ausente são tratados sem expor retorno bruto", async () => {
  let count = 0;
  const res = await consulta(request("ABC1D23"), env, async () =>
    Response.json(
      ++count === 1 ? saldo : { error: true, segredo: "test-secret" },
    ),
  );
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /test-secret/);
});
test("redirecionamento bloqueado sem seguir destino nem enviar consulta", async () => {
  let calls = 0;
  const res = await consulta(request(), env, async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "https://other.test" },
    });
  });
  assert.equal(res.status, 502);
  assert.equal(calls, 1);
});
test("consulta simples usa só o endpoint básico e devolve marca, modelo, cor e anos", async () => {
  const calls = [];
  const res = await consulta(request(), env, async (url) => {
    calls.push(url);
    return Response.json(
      calls.length === 1
        ? saldo
        : {
            error: false,
            basico: {
              error: false,
              dados: {
                marca: "Marca",
                modelo: "Modelo",
                cor: "Prata",
                ano: "2020",
                anoModelo: "2021",
                motor: "extra",
                fipe: { valor: 123 },
              },
            },
          },
    );
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [
    "https://vehicle-api.example/v3/saldo",
    "https://vehicle-api.example/v3/basico/ABC1234",
  ]);
  assert.deepEqual((await res.json()).dados, {
    marca: "Marca",
    modelo: "Modelo",
    cor: "Prata",
    ano: "2020",
    anoModelo: "2021",
  });
});
test("saldo mostra somente consultas inteiras disponíveis, sem chamada paga", async () => {
  for (const [centavos, expected] of [
    [100, 33],
    [2, 0],
    [0, 0],
  ]) {
    let calls = 0;
    const res = await statusApi(
      new Request("https://site.test/api/status"),
      env,
      async (url) => {
        assert.ok(url.endsWith("/saldo"));
        calls++;
        return Response.json({ ...saldo, saldo_centavos: centavos });
      },
    );
    assert.deepEqual(await res.json(), {
      ok: true,
      consultas_disponiveis: expected,
    });
    assert.equal(calls, 1);
  }
  for (const change of [{ produto: "outro" }, { preco_consulta_centavos: 4 }]) {
    const res = await statusApi(
      new Request("https://site.test/api/status"),
      env,
      async () => Response.json({ ...saldo, ...change }),
    );
    assert.equal(res.status, 409);
  }
});

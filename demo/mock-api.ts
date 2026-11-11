let remaining = 20;
export async function demoFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  if (path === "/api/status")
    return Response.json({ consultas_disponiveis: remaining });
  if (path === "/api/consulta") {
    const { placa } = JSON.parse(String(options?.body));
    if (remaining === 0)
      return Response.json(
        {
          message:
            "Saldo fictício esgotado. Recarregue a página para reiniciar a demonstração.",
        },
        { status: 402 },
      );
    remaining -= 1;
    await new Promise((resolve) => setTimeout(resolve, 350));
    return Response.json({
      placa,
      dados: {
        marca: "Marca fictícia",
        modelo: "Modelo de exemplo",
        cor: "Prata",
        ano: "2020",
        anoModelo: "2021",
      },
    });
  }
  return Response.json(
    {
      message:
        "PDF desativado na demonstração. Veja a implementação comentada no repositório; nenhum arquivo foi enviado.",
    },
    { status: 503 },
  );
}

import { demoFetch } from "../demo/mock-api";
import { useEffect, useRef, useState } from "react";
import {
  extractText,
  groupPlates,
  normalizePlate,
  validPlate,
} from "../lib/plates.mjs";

type RecordRow = {
  placa: string;
  status: string;
  pagina: number | null;
  linha?: number;
  hora: string;
};
type Extraction = {
  registros: RecordRow[];
  observacoes: string;
  paginas_analisadas: number[];
  id?: string;
};
type Vehicle = {
  placa: string;
  dados: {
    marca?: string;
    modelo?: string;
    cor?: string;
    ano?: string;
    anoModelo?: string;
  };
};
type Mode = "placa" | "texto" | "pdf";
const money = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const location = (r: RecordRow) =>
  [
    r.pagina ? `p. ${r.pagina}` : r.linha ? `linha ${r.linha}` : "Digitada",
    r.hora,
  ]
    .filter(Boolean)
    .join(" · ");

export default function Home() {
  const [mode, setMode] = useState<Mode>("placa");
  const [plate, setPlate] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [source, setSource] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [vehicles, setVehicles] = useState<Record<string, Vehicle>>({});
  const [attempted, setAttempted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [balanceError, setBalanceError] = useState("");
  const [pendingExtraction, setPendingExtraction] = useState<string | null>(
    null,
  );
  const running = useRef(false);
  const balanceRunning = useRef(false);
  const stop = useRef(false);

  async function refreshBalance() {
    if (balanceRunning.current) return;
    balanceRunning.current = true;
    setBalanceBusy(true);
    try {
      const response = await demoFetch("/api/status");
      const data = (await response.json()) as {
        consultas_disponiveis: number;
        message?: string;
      };
      if (!response.ok || !Number.isInteger(data.consultas_disponiveis))
        throw new Error(data.message || "Saldo indisponível");
      setBalance(data.consultas_disponiveis);
      setBalanceError("");
    } catch (e) {
      setBalance(null);
      setBalanceError(e instanceof Error ? e.message : "Saldo indisponível");
    } finally {
      balanceRunning.current = false;
      setBalanceBusy(false);
    }
  }
  useEffect(() => {
    void refreshBalance();
  }, []);

  function acceptExtraction(data: Extraction, name: string) {
    setExtraction(data);
    setSource(name);
    setPendingExtraction(null);
    setSelected(
      new Set(
        groupPlates(data.registros).plates.map(
          (p: { placa: string }) => p.placa,
        ),
      ),
    );
  }

  async function identify(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    setError("");
    if (mode === "placa") {
      const normalized = normalizePlate(plate);
      if (!validPlate(normalized)) {
        setError("Digite uma placa válida.");
        return;
      }
      setPlate(normalized);
      acceptExtraction(
        {
          registros: [
            { placa: normalized, status: "completa", pagina: null, hora: "" },
          ],
          observacoes: "",
          paginas_analisadas: [],
        },
        "Placa digitada",
      );
      return;
    }
    if (mode === "texto") {
      try {
        acceptExtraction(extractText(text), "Texto colado");
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    if (!file) {
      setError("Selecione um PDF.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("Selecione um PDF de até 8 MB.");
      return;
    }
    running.current = true;
    setBusy("Lendo o PDF completo…");
    setExtraction(null);
    setPendingExtraction(null);
    setSource(file.name);
    try {
      const response = await demoFetch("/api/extrair", {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      });
      const data = (await response.json()) as Extraction & { message?: string };
      if (!response.ok) {
        if (data.id) setPendingExtraction(data.id);
        throw new Error(data.message);
      }
      acceptExtraction(data, file.name);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Leitura interrompida. Enviar o mesmo PDF verifica a tentativa anterior.",
      );
    } finally {
      running.current = false;
      setBusy("");
    }
  }

  async function checkExtraction() {
    if (!pendingExtraction || running.current) return;
    running.current = true;
    setBusy("Verificando leitura…");
    setError("");
    try {
      const response = await demoFetch(
        `/api/extrair?id=${encodeURIComponent(pendingExtraction)}`,
      );
      const data = (await response.json()) as Extraction & { message?: string };
      if (!response.ok) throw new Error(data.message);
      acceptExtraction(data, source);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setBusy("");
    }
  }

  const grouped = extraction
    ? groupPlates(extraction.registros)
    : { plates: [], issues: [] };
  const toQuery: string[] = grouped.plates
    .map((p: { placa: string }) => p.placa)
    .filter((p: string) => selected.has(p) && !attempted.has(p));
  async function querySelected() {
    if (running.current || !toQuery.length) return;
    running.current = true;
    stop.current = false;
    setError("");
    const queue = [...toQuery];
    try {
      for (let i = 0; i < queue.length; i++) {
        if (stop.current) break;
        const placa = queue[i];
        setBusy(`Consultando ${i + 1} de ${queue.length}…`);
        setAttempted((previous) => new Set([...previous, placa]));
        const response = await demoFetch("/api/consulta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ placa }),
        });
        const data = (await response.json()) as Vehicle & { message?: string };
        if (!response.ok)
          throw new Error(
            `${placa}: ${data.message || "Consulta interrompida. Confira o saldo antes de repetir."}`,
          );
        setVehicles((previous) => ({ ...previous, [placa]: data }));
        setBalance((previous) =>
          previous === null ? null : Math.max(0, previous - 1),
        );
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Conexão interrompida. Pode ter ocorrido cobrança; confira o saldo antes de repetir.",
      );
    } finally {
      running.current = false;
      setBusy("");
      await refreshBalance();
    }
  }

  return (
    <main>
      <p className="demo-notice">
        Demonstração local · dados fictícios · nenhuma consulta real. PDF
        desativado nesta versão.
      </p>
      <header>
        <h1>Consultar Placas</h1>
        <section className="balance" aria-label="Saldo da API PLACAS">
          <div>
            <span>Consultas disponíveis</span>
            <strong aria-live="polite">
              {balanceBusy
                ? "…"
                : balance === null
                  ? "—"
                  : balance.toLocaleString("pt-BR")}
            </strong>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Atualizar saldo"
            title="Atualizar saldo"
            disabled={balanceBusy || !!busy}
            onClick={refreshBalance}
          >
            ↻
          </button>
          {balanceError && <small role="status">{balanceError}</small>}
        </section>
      </header>

      <section className="entry" aria-label="Entrada de placas">
        <div className="tabs" role="tablist" aria-label="Como inserir placas">
          {(
            [
              ["placa", "Uma placa"],
              ["texto", "Colar texto"],
              ["pdf", "Enviar PDF"],
            ] as [Mode, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              id={`tab-${value}`}
              role="tab"
              aria-selected={mode === value}
              aria-controls={`panel-${value}`}
              tabIndex={mode === value ? 0 : -1}
              disabled={!!busy}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const modes: Mode[] = ["placa", "texto", "pdf"];
                  const next =
                    modes[
                      (modes.indexOf(mode) + (e.key === "ArrowRight" ? 1 : 2)) %
                        3
                    ];
                  setMode(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }
              }}
              onClick={() => {
                setMode(value);
                setError("");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          onSubmit={identify}
          role="tabpanel"
          id={`panel-${mode}`}
          aria-labelledby={`tab-${mode}`}
        >
          {mode === "placa" && (
            <div className="single-row">
              <label className="sr-only" htmlFor="plate">
                Placa
              </label>
              <input
                id="plate"
                className="plate-input"
                placeholder="ABC1D23"
                value={plate}
                maxLength={9}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
                spellCheck={false}
                autoComplete="off"
                disabled={!!busy}
                required
              />
              <button type="submit" disabled={!!busy}>
                Continuar
              </button>
            </div>
          )}
          {mode === "texto" && (
            <>
              <label className="sr-only" htmlFor="text">
                Texto com placas
              </label>
              <textarea
                id="text"
                placeholder="Cole o texto com as placas…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={!!busy}
                required
              />
              <div className="entry-actions">
                <button type="submit" disabled={!!busy}>
                  Identificar placas
                </button>
              </div>
            </>
          )}
          {mode === "pdf" && (
            <>
              <label className="file-label" htmlFor="pdf">
                Selecionar PDF
              </label>
              <input
                id="pdf"
                type="file"
                accept="application/pdf,.pdf"
                disabled={!!busy}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <div className="entry-actions">
                <span className="muted">
                  Até 20 páginas · 8 MB · inclui digitalizações
                </span>
                <button type="submit" disabled={!!busy || !file}>
                  Extrair placas
                </button>
              </div>
            </>
          )}
        </form>
      </section>

      {busy && (
        <div className="progress" role="status">
          <span>{busy}</span>
          {busy.startsWith("Consultando") && (
            <button
              className="text-button"
              onClick={() => {
                stop.current = true;
              }}
            >
              Parar após esta
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pendingExtraction && !busy && (
        <button className="text-button" onClick={checkExtraction}>
          Verificar extração
        </button>
      )}

      {extraction && (
        <section className="review" aria-label="Revisar placas">
          <div className="section-heading">
            <h2>
              Revisar placas <span>{grouped.plates.length}</span>
            </h2>
            <span className="source" title={source}>
              {source}
            </span>
          </div>
          {grouped.plates.length === 0 && (
            <p className="muted">Nenhuma placa completa identificada.</p>
          )}
          {grouped.plates.length > 0 && (
            <>
              <div className="review-tools">
                <label>
                  <input
                    type="checkbox"
                    checked={
                      toQuery.length > 0 &&
                      toQuery.length ===
                        grouped.plates.filter(
                          (p: { placa: string }) => !attempted.has(p.placa),
                        ).length
                    }
                    disabled={!!busy}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(
                              grouped.plates.map(
                                (p: { placa: string }) => p.placa,
                              ),
                            )
                          : new Set(),
                      )
                    }
                  />
                  Selecionar todas
                </label>
                <span className="muted">
                  {extraction.registros.filter((r) => r.status === "completa")
                    .length -
                    grouped.plates.length >
                  0
                    ? "Repetidas agrupadas"
                    : ""}
                </span>
              </div>
              <div className="plate-list">
                {grouped.plates.map(
                  (p: { placa: string; ocorrencias: RecordRow[] }) => (
                    <label className="plate-row" key={p.placa}>
                      <input
                        type="checkbox"
                        checked={selected.has(p.placa)}
                        disabled={!!busy || attempted.has(p.placa)}
                        onChange={(e) =>
                          setSelected((previous) => {
                            const next = new Set(previous);
                            if (e.target.checked) next.add(p.placa);
                            else next.delete(p.placa);
                            return next;
                          })
                        }
                      />
                      <strong>{p.placa}</strong>
                      <span
                        className="occurrences"
                        title={p.ocorrencias.map(location).join("; ")}
                      >
                        {[
                          ...new Set(
                            p.ocorrencias.map((r) =>
                              r.pagina
                                ? `p. ${r.pagina}`
                                : r.linha
                                  ? `linha ${r.linha}`
                                  : "",
                            ),
                          ),
                        ]
                          .filter(Boolean)
                          .join(", ")}
                        {p.ocorrencias.length > 1
                          ? ` · ${p.ocorrencias.length} ocorrências`
                          : ""}
                      </span>
                      {attempted.has(p.placa) && (
                        <span className="queried">
                          {vehicles[p.placa]
                            ? "Consultada"
                            : "Conferir tentativa"}
                        </span>
                      )}
                    </label>
                  ),
                )}
              </div>
              <div className="query-actions">
                <span className="muted">R$ 0,03 por placa</span>
                <button
                  onClick={querySelected}
                  disabled={!!busy || !toQuery.length || balance === 0}
                >
                  Consultar {toQuery.length}{" "}
                  {toQuery.length === 1 ? "placa" : "placas"} ·{" "}
                  {money(toQuery.length * 0.03)}
                </button>
              </div>
            </>
          )}
          {grouped.issues.length > 0 && (
            <details className="issues">
              <summary>
                {grouped.issues.length}{" "}
                {grouped.issues.length === 1
                  ? "registro parcial ou ilegível"
                  : "registros parciais ou ilegíveis"}
              </summary>
              {grouped.issues.map((r: RecordRow, i: number) => (
                <div key={i}>
                  <code>{r.placa || "Sem leitura"}</code>
                  <span>
                    {location(r)} ·{" "}
                    {r.status === "parcial" ? "Parcial" : "Ilegível"}
                  </span>
                </div>
              ))}
            </details>
          )}
          {extraction.observacoes && (
            <p className="extraction-note">{extraction.observacoes}</p>
          )}
        </section>
      )}

      {Object.keys(vehicles).length > 0 && (
        <section className="results" aria-label="Resultados">
          <div className="section-heading">
            <h2>
              Resultados <span>{Object.keys(vehicles).length}</span>
            </h2>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Placa</th>
                  <th>Marca / modelo</th>
                  <th>Cor</th>
                  <th>Ano fab. / mod.</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(vehicles).map((v) => (
                  <tr key={v.placa}>
                    <td className="plate-cell">{v.placa}</td>
                    <td>
                      {[v.dados.marca, v.dados.modelo]
                        .filter(Boolean)
                        .join(" / ") || "—"}
                    </td>
                    <td>{v.dados.cor || "—"}</td>
                    <td>
                      {v.dados.ano || "—"} / {v.dados.anoModelo || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

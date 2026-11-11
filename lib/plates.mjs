export const validPlate = (value) =>
  /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(value);
export const normalizePlate = (value) =>
  value.toUpperCase().replace(/[\s-]/g, "");
export const MAX_TEXT = 100000;

// No inference or character substitutions. Preserve every occurrence and its line.
export function extractText(text) {
  if (typeof text !== "string" || !text.trim())
    throw new Error("Cole o texto com as placas.");
  if (text.length > MAX_TEXT)
    throw new Error(
      "O texto excede 100 mil caracteres. Divida-o antes de continuar.",
    );
  const registros = [];
  text
    .toUpperCase()
    .split(/\r?\n/)
    .forEach((line, i) => {
      const pattern =
        /(?<![A-Z0-9])[A-Z]{3}[ -]?[0-9][A-Z0-9][0-9]{2}(?![A-Z0-9])/g;
      const occupied = [];
      for (const match of line.matchAll(pattern)) {
        occupied.push([match.index, match.index + match[0].length]);
        registros.push({
          placa: normalizePlate(match[0]),
          status: "completa",
          pagina: null,
          linha: i + 1,
          hora: "",
        });
      }
      for (const match of line.matchAll(
        /(?<![A-Z0-9?*_-])[A-Z0-9?*_-]{7}(?![A-Z0-9?*_-])/g,
      )) {
        const value = match[0];
        if (
          !/[?*_-]/.test(value) ||
          !/[A-Z]/.test(value) ||
          occupied.some(
            ([a, b]) => match.index < b && match.index + value.length > a,
          )
        )
          continue;
        if (!/^[A-Z?*_-]{3}[0-9?*_-][A-Z0-9?*_-][0-9?*_-]{2}$/.test(value))
          continue;
        registros.push({
          placa: value,
          status: "parcial",
          pagina: null,
          linha: i + 1,
          hora: "",
        });
      }
      if (/\b(?:SEM LEITURA|ILEG[IÍ]VEL)\b/.test(line))
        registros.push({
          placa: "",
          status: "sem_leitura",
          pagina: null,
          linha: i + 1,
          hora: "",
        });
    });
  if (registros.length > 2000)
    throw new Error(
      "Mais de 2.000 registros. Divida o texto antes de continuar.",
    );
  return { registros, paginas_analisadas: [], observacoes: "" };
}

export function groupPlates(registros) {
  const complete = new Map();
  const issues = [];
  for (const record of registros) {
    const plate = normalizePlate(record.placa);
    if (record.status !== "completa" || !validPlate(plate)) {
      issues.push(record);
      continue;
    }
    if (!complete.has(plate))
      complete.set(plate, { placa: plate, ocorrencias: [] });
    complete.get(plate).ocorrencias.push(record);
  }
  return { plates: [...complete.values()], issues };
}

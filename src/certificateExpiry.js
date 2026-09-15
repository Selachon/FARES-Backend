// Shared application rules for the certificates panel and inventory.
// Dates intentionally follow the existing fechaCargue calculation.
export function yearsToExpire({ tipoInspeccion, tipoEquipo }) {
  if (tipoInspeccion === "PARCIAL") return 1;
  if (tipoInspeccion === "TOTAL")
    return tipoEquipo === "CT" ? 5 : tipoEquipo === "TE" ? 10 : null;
  return null;
}
export function computeCertificateExpiry(certificate, now = new Date()) {
  const { fechaCargue, status } = certificate;
  const baseDate = fechaCargue ? new Date(fechaCargue) : null,
    years = yearsToExpire(certificate);
  if (!baseDate || !Number.isFinite(baseDate.getTime()) || !years)
    return {
      dueDate: null,
      daysLeft: null,
      isExpiringSoon: false,
      computedStatus: status || null,
    };
  const due = new Date(baseDate);
  due.setFullYear(due.getFullYear() + years);
  const daysLeft = Math.floor((due - now) / 86400000);
  const computedStatus =
    String(status || "").toUpperCase() === "RENOVADO"
      ? status
      : now > due
        ? "VENCIDO"
        : "ACTIVO";
  return {
    dueDate: due.toISOString(),
    daysLeft,
    isExpiringSoon:
      computedStatus === "ACTIVO" && daysLeft >= 0 && daysLeft <= 15,
    computedStatus,
  };
}

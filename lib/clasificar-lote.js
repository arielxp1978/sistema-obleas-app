/**
 * Clasificación de un item del lote de dalegas → categoría de renovación.
 *
 * FUENTE ÚNICA: la usan el navegador (public/index.html la carga desde
 * /js/clasificar-lote.js) y el servidor (lib/verificacion-auto.js, la corrida
 * automática diaria). No duplicar esta lógica en ningún otro lado.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.clasificarItemLote = factory().clasificarItemLote;
})(typeof self !== 'undefined' ? self : this, function () {
  function clasificarItemLote(item, config) {
    config = config || {};
    const base = { pecNombre: '-', tallerNombre: '-', tallerCodigo: '-', pecCodigo: '-', fechaOp: '-', nuevoVto: '-' };
    if (item.status === 'pendiente') return { codigo: 'PENDIENTE', texto: 'Verificando...', ...base };
    // status:error = S14 no pudo procesar (cruce de datos, timeout, etc.)
    if (item.status === 'error') return { codigo: 'ERROR_TECNICO', texto: item.error || 'Error técnico', ...base };
    const r = item.resultado;
    if (!r) return { codigo: 'NO_RENOVO', texto: 'No Renovó', ...base };
    // resultado.error: "0"=ok, "2"=sin GNC, "4"=procesando, "8"=baja
    if (String(r.error) === '2' || r.estado === 'not_found') return { codigo: 'NO_RENOVO', texto: 'No Renovó', ...base };
    if (String(r.error) === '4') return { codigo: 'PROCESANDO', texto: 'Procesando...', ...base };
    if (String(r.error) === '8') return { codigo: 'BAJA_GNC', texto: 'Dado de baja / Desmontaje', ...base };
    if (String(r.error) !== '0') return { codigo: 'NO_RENOVO', texto: 'No Renovó', ...base };
    // error=0 → tiene GNC vigente. Campos en resultado.data (formato ENARGAS estándar)
    const data = r.data || {};
    const datosPEC = data.datosPEC || {};
    const datosTaller = data.datosTaller || {};
    const datosOp = data.datosOperacion || {};
    const pec = String(datosPEC.codigo || '');
    const taller = String(datosTaller.codigo || '');
    const enriquecido = {
      pecCodigo: pec, pecNombre: datosPEC.razonSocial || pec || '-',
      tallerCodigo: taller, tallerNombre: datosTaller.razonSocial || taller || '-',
      fechaOp: datosOp.fechaHabilitacion ? datosOp.fechaHabilitacion.split('T')[0] : '-',
      nuevoVto: datosOp.fechaVencimiento ? datosOp.fechaVencimiento.split('T')[0] : '-'
    };
    const pecPropios = config.pecPropios || ['3145', '3286'];
    const talleresPropios = config.talleresPropios || ['IRT0550', 'HIT0797', 'QUT0856'];
    if (pecPropios.includes(pec) && talleresPropios.includes(taller))
      return { codigo: 'NUESTRO_PEC_NUESTRO_TALLER', texto: 'Nuestro PEC + Nuestro Taller', ...enriquecido };
    if (pecPropios.includes(pec))
      return { codigo: 'NUESTRO_PEC_OTRO_TALLER', texto: 'Nuestro PEC + Taller Externo', ...enriquecido };
    return { codigo: 'OTRO_PEC', texto: 'Otro PEC', ...enriquecido };
  }
  return { clasificarItemLote };
});

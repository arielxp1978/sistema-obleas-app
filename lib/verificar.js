/**
 * Verificación post-envío contra API ENARGAS
 */

function parseArgDate(str) {
  if (!str) return null;
  const parts = str.split('/');
  if (parts.length === 3) {
    const [d, m, y] = parts.map(Number);
    return new Date(y, m - 1, d);
  }
  return null;
}

function clasificarPatente(registro, apiResp, config) {
  const noRenovo = (extra = {}) => ({
    codigo: 'NO_RENOVO', texto: 'No Renovó', pecNombre: '-', tallerNombre: '-',
    tallerCodigo: '-', pecCodigo: '-', fechaOp: '-', nuevoVto: '-', ...extra
  });

  if (!apiResp || (apiResp.error !== '0' && apiResp.error !== 0)) return noRenovo();
  const data = apiResp.data;
  if (!data || !data.datosOperacion) return noRenovo();

  const pecCodigo = data.datosPEC ? data.datosPEC.codigo : '';
  const pecNombre = data.datosPEC ? data.datosPEC.razonSocial : '-';
  const tallerCodigo = data.datosTaller ? data.datosTaller.codigo : '';
  const tallerNombre = data.datosTaller ? data.datosTaller.razonSocial : '-';
  const fechaOp = data.datosOperacion.fechaHabilitacion ? data.datosOperacion.fechaHabilitacion.split('T')[0] : '-';
  const nuevoVto = data.datosOperacion.fechaVencimiento ? data.datosOperacion.fechaVencimiento.split('T')[0] : '-';

  const base = { pecNombre, tallerNombre, tallerCodigo, pecCodigo, fechaOp, nuevoVto };

  const vtoOrigDate = parseArgDate(registro.UFECVENHAB || '');
  const fechaOpDate = data.datosOperacion.fechaHabilitacion ? new Date(data.datosOperacion.fechaHabilitacion) : null;
  const esNuevaOp = fechaOpDate && vtoOrigDate && fechaOpDate >= vtoOrigDate;

  if (!esNuevaOp) return { codigo: 'NO_RENOVO', texto: 'No Renovó', ...base };

  const esPecNuestro = config.pecPropios.includes(pecCodigo);
  const esTallerNuestro = config.talleresPropios.includes(tallerCodigo);

  if (esPecNuestro && esTallerNuestro) return { codigo: 'NUESTRO_PEC_NUESTRO_TALLER', texto: 'Nuestro PEC + Nuestro Taller', ...base };
  if (esPecNuestro) return { codigo: 'NUESTRO_PEC_OTRO_TALLER', texto: 'Nuestro PEC + Taller Externo', ...base };
  return { codigo: 'OTRO_PEC', texto: 'Otro PEC', ...base };
}

async function consultarPatente(dominio, config) {
  const url = `${config.apiUrl}/api/consulta?patente=${encodeURIComponent(dominio)}&formato=enargas`;
  const resp = await fetch(url, {
    headers: { 'X-API-Key': config.apiKey },
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

module.exports = { clasificarPatente, consultarPatente, parseArgDate };

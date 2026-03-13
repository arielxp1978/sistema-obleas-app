/**
 * Normalización de teléfonos argentinos
 * Total: 10 dígitos = código de área + abonado
 */

const AREA_2 = new Set(["11"]);
const AREA_3 = new Set([
  "220","221","223","230","236","237","249","260","261","263","264","266",
  "280","291","294","297","298","299","336","341","342","343","345","346",
  "348","351","353","354","356","358","362","364","370","376","379","380",
  "381","383","385","387","388"
]);
const AREA_4 = new Set([
  "2202","2221","2223","2224","2225","2226","2227","2229","2241","2242",
  "2243","2244","2245","2246","2252","2254","2255","2257","2261","2262",
  "2264","2265","2266","2267","2268","2271","2272","2273","2274","2281",
  "2283","2284","2285","2286","2291","2292","2296","2297","2302","2314",
  "2316","2317","2320","2323","2324","2325","2326","2331","2333","2334",
  "2335","2336","2337","2338","2342","2343","2344","2345","2346","2352",
  "2353","2354","2355","2356","2357","2358","2362","2392","2393","2394",
  "2395","2396","2473","2474","2475","2477","2478",
  "3327","3329","3382","3385","3387","3388",
  "3400","3401","3402","3404","3405","3406","3407","3408","3409",
  "3435","3436","3437","3438","3442","3444","3445","3446","3447",
  "3454","3455","3456","3458","3460","3462","3463","3464","3465",
  "3466","3467","3468","3469","3471","3472","3476","3482","3483",
  "3487","3489","3491","3492","3493","3496","3497","3498",
  "3521","3522","3524","3525","3532","3533","3537","3541","3542",
  "3543","3544","3546","3547","3548","3549","3562","3563","3564",
  "3571","3572","3573","3574","3575","3576","3582","3583","3584","3585",
  "3711","3715","3716","3718","3721","3725","3731","3734","3735",
  "3741","3743","3751","3754","3755","3756","3757","3758",
  "3772","3773","3774","3775","3777","3781","3782","3786",
  "3821","3825","3826","3827","3832","3835","3837","3838",
  "3841","3843","3844","3845","3846","3854","3855","3856","3857","3858",
  "3861","3862","3863","3865","3867","3868","3869","3873","3876","3877",
  "3878","3884","3885","3886","3887","3888","3891","3892","3894"
]);

function detectArea(num) {
  if (num.length < 6) return [null, num];
  if (num.length >= 4 && AREA_4.has(num.slice(0, 4))) return [num.slice(0, 4), num.slice(4)];
  if (AREA_3.has(num.slice(0, 3))) return [num.slice(0, 3), num.slice(3)];
  if (AREA_2.has(num.slice(0, 2))) return [num.slice(0, 2), num.slice(2)];
  if (num.length >= 10 && (num[0] === '2' || num[0] === '3')) return [num.slice(0, 4), num.slice(4)];
  if (num.length === 10 && (num[0] === '2' || num[0] === '3')) return [num.slice(0, 3), num.slice(3)];
  return [null, num];
}

function normalizarTel(raw) {
  const rej = (d, tipo, desc) => ({ limpio: d, whatsapp: '', estado: 'RECHAZAR', errorTipo: tipo, errorDesc: desc });
  const lev = (d, tipo, desc) => ({ limpio: d, whatsapp: '', estado: 'LEVE', errorTipo: tipo, errorDesc: desc });
  const ok = (d) => ({ limpio: d, whatsapp: '549' + d, estado: 'OK', errorTipo: 'NINGUNO', errorDesc: '' });

  if (!raw) return rej('', 'SIN_TELEFONO', 'Sin número');
  let d = raw.toString().replace(/[^\d]/g, '');
  if (!d || d === '0') return rej(d, 'SIN_TELEFONO', 'Sin número');
  if (/^[01]+$/.test(d) && d.length < 8) return rej(d, 'BASURA', 'Solo 0 y 1');
  if (new Set(d).size === 1) return rej(d, 'REPETIDO', 'Dígitos repetidos');
  if (['123456789', '987654321', '1234567890', '0123456789'].includes(d)) return rej(d, 'SECUENCIA', 'Secuencia obvia');

  if (d.startsWith('00')) d = d.slice(2);
  let local;
  if (d.startsWith('54')) {
    const s = d.slice(2);
    local = s.startsWith('9') ? s.slice(1) : s;
  } else { local = d; }
  if (local.startsWith('0')) local = local.slice(1);

  if (local.length === 10) return ok(local);

  const [area, rest] = detectArea(local);
  if (area && rest.startsWith('15') && rest.length > 2) {
    const sinQuince = area + rest.slice(2);
    if (sinQuince.length === 10) local = sinQuince;
  }

  if (local.length === 10) return ok(local);
  if (local.length > 10) {
    for (const al of [4, 3, 2]) {
      if (al <= local.length) {
        const pa = local.slice(0, al), pr = local.slice(al);
        if (pr.startsWith('15')) {
          const cl = pa + pr.slice(2);
          if (cl.length === 10) return ok(cl);
        }
      }
    }
    return lev(local, 'LARGO', `${local.length} dígitos (sobran ${local.length - 10})`);
  }
  if (local.length < 6) return rej(local, 'MUY_CORTO', `Solo ${local.length} dígitos`);

  const descMap = { 7: 'Falta código de área (3 díg.)', 6: 'Falta código de área (4 díg.)', 8: 'Falta código de área (2 díg.)', 9: `${local.length} dígitos (falta 1)` };
  return lev(local, 'FALTAN_DIGITOS', descMap[local.length] || `${local.length} dígitos`);
}

function analizarTelError(raw) {
  if (!raw) return 'SIN_TELEFONO';
  const d = raw.toString().replace(/[^\d]/g, '');
  if (!d || d === '0') return 'SIN_TELEFONO';
  if (d.length < 6) return 'MUY_CORTO';
  if (new Set(d).size === 1) return 'REPETIDO_OBVIO';
  if (['123456789', '987654321', '1234567890', '0123456789'].includes(d)) return 'SECUENCIA_OBVIA';
  for (const c of new Set(d)) { if (d.split(c).length - 1 > d.length * 0.7) return 'MUCHOS_REPETIDOS'; }
  return 'POSIBLE_OK';
}

module.exports = { normalizarTel, analizarTelError, detectArea };

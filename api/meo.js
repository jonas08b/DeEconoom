/**
 * /api/meo  — Live macro-data aggregator
 *
 * Bronnen (alle gratis, geen API-key):
 *  - ECB Data Portal   → EU HICP, BE HICP, Eurozone werkloosheid, ECB-rente
 *  - FRED (St. Louis)  → VS CPI, werkloosheid, BBP
 *  - OECD SDMX/JSON   → EU BBP (kwartaal), BE BBP, BE werkloosheid
 *  - FRED ISM-series  → VS ISM Manufacturing PMI (NAPM)
 *  - World Bank API   → China CPI, werkloosheid, BBP, plus EU/BE/VS als fallback
 *
 * Cache: 4 uur op Vercel edge (s-maxage), 1 uur stale-while-revalidate
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=14400, stale-while-revalidate=3600');

  try {
    const data = await Promise.allSettled([
      fetchECBAll(),
      fetchFREDAll(),
      fetchOECDAll(),
      fetchWorldBankAll(),
    ]);

    const [ecb, fred, oecd, wb] = data.map(r => r.status === 'fulfilled' ? r.value : {});

    const result = {
      eu: buildEU(ecb, oecd, fred),
      be: buildBE(ecb, oecd),
      us: buildUS(fred),
      cn: buildCN(wb),
      rates: buildRates(ecb),
      ts: Date.now(),
    };

    res.status(200).json(result);
  } catch (e) {
    console.error('MEO API fout:', e.message);
    res.status(500).json({ error: e.message });
  }
}

/* ─── HELPERS ──────────────────────────────────────────── */

function timeout(ms) { return AbortSignal.timeout(ms); }

function parseECBSeries(d) {
  const times = d.structure.dimensions.observation[0].values;
  const series = Object.values(d.dataSets[0].series)[0];
  return times
    .map((t, i) => ({ period: t.id, val: series.observations[String(i)]?.[0] ?? null }))
    .filter(p => p.val !== null);
}

function lastN(arr, n) { return arr.slice(-n); }
function vals(arr) { return arr.map(p => p.val); }

/* ─── ECB DATA PORTAL ───────────────────────────────────── */

async function fetchECBAll() {
  const base = 'https://data-api.ecb.europa.eu/service/data';
  const opts = { signal: timeout(10000) };
  const fmt  = '?format=jsondata';

  const [rateR, euHicp, beHicp, euUnem, euBbpR] = await Promise.allSettled([
    fetch(`${base}/FM/B.U2.EUR.RT0.DZ.N.R.S.B.N.A${fmt}&lastNObservations=18`, opts).then(r => r.json()),
    fetch(`${base}/ICP/M.U2.N.000000.4.ANR${fmt}&lastNObservations=24`, opts).then(r => r.json()),
    fetch(`${base}/ICP/M.BE.N.000000.4.ANR${fmt}&lastNObservations=24`, opts).then(r => r.json()),
    fetch(`${base}/LFSI/M.I8.S.UNEHRT.TOTAL0.15_74.T${fmt}&lastNObservations=24`, opts).then(r => r.json()),
    // Eurozone BBP via ECB (kwartaal, seizoensgecorrigeerd, volume)
    fetch(`${base}/MNA/Q.Y.I8.W2.S1.S1.B.B1GQ._Z._Z._Z.EUR.LR.GY${fmt}&lastNObservations=12`, opts).then(r => r.json()),
  ]);

  const parse = r => r.status === 'fulfilled' ? parseECBSeries(r.value) : [];

  const rate   = parse(rateR);
  const hicp   = parse(euHicp);
  const hicpBE = parse(beHicp);
  const unem   = parse(euUnem);
  const bbp    = parse(euBbpR);

  return { rate, hicp, hicpBE, unem, bbp };
}

/* ─── FRED (St. Louis Fed) ──────────────────────────────── */

async function fetchFREDSeries(id, n = 30) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
  const r = await fetch(url, { signal: timeout(10000) });
  const text = await r.text();
  const rows = text.trim().split('\n').slice(1)
    .map(l => { const [date, val] = l.split(','); return { date: date.trim(), val: parseFloat(val) }; })
    .filter(x => !isNaN(x.val));
  return lastN(rows, n);
}

async function fetchFREDAll() {
  const [cpiRaw, unem, gdp, ism] = await Promise.allSettled([
    fetchFREDSeries('CPIAUCSL', 30),   // CPI level (we berekenen YoY)
    fetchFREDSeries('UNRATE', 24),
    fetchFREDSeries('A191RL1Q225SBEA', 14), // reëel BBP kwartaalgroei %
    fetchFREDSeries('NAPM', 24),            // ISM Manufacturing PMI
  ]);

  const get = r => r.status === 'fulfilled' ? r.value : [];

  // CPI YoY berekening
  const cpiRows = get(cpiRaw);
  let inflation = null;
  if (cpiRows.length >= 14) {
    const yoyHist = [];
    for (let i = 12; i < cpiRows.length; i++) {
      const yoy = (cpiRows[i].val - cpiRows[i - 12].val) / cpiRows[i - 12].val * 100;
      yoyHist.push({ date: cpiRows[i].date, val: +yoy.toFixed(2) });
    }
    const cur = yoyHist[yoyHist.length - 1];
    const prv = yoyHist[yoyHist.length - 2];
    inflation = {
      current: cur?.val ?? null,
      prev:    prv?.val ?? null,
      period:  cur?.date ?? null,
      hist:    yoyHist.map(p => p.val),
    };
  }

  return {
    inflation,
    unemployment: toSeries(get(unem)),
    gdp:          toSeries(get(gdp)),
    ism:          toSeries(get(ism)),
  };
}

function toSeries(rows) {
  if (!rows.length) return null;
  return {
    current: rows[rows.length - 1].val,
    prev:    rows[rows.length - 2]?.val ?? null,
    period:  rows[rows.length - 1].date,
    hist:    rows.map(r => r.val),
  };
}

/* ─── OECD SDMX JSON ────────────────────────────────────── */

async function fetchOECDSeries(url) {
  const r = await fetch(url, { signal: timeout(12000), headers: { Accept: 'application/json' } });
  const d = await r.json();
  // OECD SDMX-JSON structuur
  const dataset = d.dataSets?.[0];
  if (!dataset) return [];
  const times = d.structure?.dimensions?.observation?.[0]?.values ?? [];
  const seriesKey = Object.keys(dataset.series)[0];
  const obs = dataset.series[seriesKey]?.observations ?? {};
  return times.map((t, i) => ({
    period: t.id,
    val:    obs[String(i)]?.[0] ?? null,
  })).filter(p => p.val !== null);
}

async function fetchOECDAll() {
  const base = 'https://sdmx.oecd.org/public/rest/data';
  const opts = '?format=jsondata&lastNObservations=14';

  const [euBbp, beBbp, beUnem] = await Promise.allSettled([
    // Eurozone BBP kwartaal (reëel, seizoensgecorrigeerd, QoQ %)
    fetchOECDSeries(`${base}/OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I,1.0/EA19+EA20.QGR.GDP.....Q${opts}`),
    // België BBP kwartaal QoQ %
    fetchOECDSeries(`${base}/OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I,1.0/BEL.QGR.GDP.....Q${opts}`),
    // België werkloosheid (maandelijks, seizoensgecorrigeerd)
    fetchOECDSeries(`${base}/OECD.SDD.TPS,DSD_LFS@DF_OECD_LFS_MONTHLY,1.0/BEL.LRUN74TT.STSA.M${opts}&lastNObservations=24`),
  ]);

  const get = r => r.status === 'fulfilled' ? r.value : [];

  return {
    euBbp:  toSeries(get(euBbp)),
    beBbp:  toSeries(get(beBbp)),
    beUnem: toSeries(get(beUnem)),
  };
}

/* ─── WORLD BANK ─────────────────────────────────────────── */

async function fetchWBSeries(indicator, country, n = 14) {
  const url = `https://api.worldbank.org/v2/country/${country}/indicator/${indicator}?format=json&mrv=${n}&per_page=${n}`;
  const r = await fetch(url, { signal: timeout(12000) });
  const [, data] = await r.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter(d => d.value !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({ period: d.date, val: d.value }));
}

async function fetchWorldBankAll() {
  const [cnCpi, cnUnem, cnGdp, cnPmiProxy] = await Promise.allSettled([
    fetchWBSeries('FP.CPI.TOTL.ZG', 'CN', 10), // China CPI inflation YoY %
    fetchWBSeries('SL.UEM.TOTL.ZS', 'CN', 10), // China unemployment (ILO modelled)
    fetchWBSeries('NY.GDP.MKTP.KD.ZG', 'CN', 10), // China GDP growth annual %
  ]);

  const get = r => r.status === 'fulfilled' ? r.value : [];

  return {
    cnCpi:  toSeries(get(cnCpi)),
    cnUnem: toSeries(get(cnUnem)),
    cnGdp:  toSeries(get(cnGdp)),
  };
}

/* ─── BUILDERS ───────────────────────────────────────────── */

function buildEU(ecb, oecd, fred) {
  const { hicp, unem, bbp: ecbBbp } = ecb ?? {};
  const { euBbp } = oecd ?? {};

  // Inflatie: ECB HICP EU
  const inflation = hicp?.length ? {
    current: hicp[hicp.length - 1].val,
    prev:    hicp[hicp.length - 2]?.val ?? null,
    period:  hicp[hicp.length - 1].period,
    hist:    vals(lastN(hicp, 18)),
    src:     'ECB/Eurostat (HICP EU)',
  } : null;

  // Werkloosheid: ECB LFSI
  const unemployment = unem?.length ? {
    current: unem[unem.length - 1].val,
    prev:    unem[unem.length - 2]?.val ?? null,
    period:  unem[unem.length - 1].period,
    hist:    vals(lastN(unem, 18)),
    src:     'ECB/Eurostat (LFSI)',
  } : null;

  // BBP: OECD voorkeur, ECB fallback
  const bbpData = euBbp ?? (ecbBbp?.length ? toSeries(ecbBbp) : null);
  const gdp = bbpData ? {
    current: bbpData.current,
    prev:    bbpData.prev,
    period:  bbpData.period,
    hist:    bbpData.hist,
    src:     'OECD/Eurostat (BBP kwartaal)',
  } : null;

  return { inflation, unemployment, gdp };
}

function buildBE(ecb, oecd) {
  const { hicpBE } = ecb ?? {};
  const { beBbp, beUnem } = oecd ?? {};

  const inflation = hicpBE?.length ? {
    current: hicpBE[hicpBE.length - 1].val,
    prev:    hicpBE[hicpBE.length - 2]?.val ?? null,
    period:  hicpBE[hicpBE.length - 1].period,
    hist:    vals(lastN(hicpBE, 18)),
    src:     'ECB/Eurostat (HICP BE)',
  } : null;

  const unemployment = beUnem ? {
    current: beUnem.current,
    prev:    beUnem.prev,
    period:  beUnem.period,
    hist:    beUnem.hist,
    src:     'OECD/Statbel',
  } : null;

  const gdp = beBbp ? {
    current: beBbp.current,
    prev:    beBbp.prev,
    period:  beBbp.period,
    hist:    beBbp.hist,
    src:     'OECD/NBB',
  } : null;

  return { inflation, unemployment, gdp };
}

function buildUS(fred) {
  const { inflation, unemployment, gdp, ism } = fred ?? {};
  return {
    inflation:    inflation ? { ...inflation, src: 'BLS via FRED' } : null,
    unemployment: unemployment ? { ...unemployment, src: 'BLS via FRED' } : null,
    gdp:          gdp ? { ...gdp, src: 'BEA via FRED' } : null,
    pmi:          ism ? { ...ism, src: 'ISM via FRED' } : null,
  };
}

function buildCN(wb) {
  const { cnCpi, cnUnem, cnGdp } = wb ?? {};

  // World Bank geeft jaardata → we converteren naar kwartaal-equivalent voor BBP
  const gdpVal = cnGdp?.current ?? null;
  const gdpQtr = gdpVal != null ? +(gdpVal / 4).toFixed(2) : null;
  const gdpPrev = cnGdp?.prev != null ? +(cnGdp.prev / 4).toFixed(2) : null;

  return {
    inflation:    cnCpi ? { ...cnCpi, src: 'World Bank / NBS China' } : null,
    unemployment: cnUnem ? { ...cnUnem, src: 'World Bank / ILO' } : null,
    gdp:          cnGdp ? {
      current: gdpQtr,
      prev:    gdpPrev,
      period:  cnGdp.period,
      hist:    cnGdp.hist?.map(v => +(v / 4).toFixed(2)),
      src:     'World Bank / NBS China',
    } : null,
  };
}

function buildRates(ecb) {
  const { rate } = ecb ?? {};
  if (!rate?.length) return null;
  return {
    ecb: {
      current: rate[rate.length - 1].val,
      period:  rate[rate.length - 1].period,
      hist:    vals(lastN(rate, 12)),
      src:     'ECB Data Portal',
    },
  };
}

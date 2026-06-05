const axios = require('axios');
const http = require('http');

// ===================================================
// CONFIGURATION (Render variables se values fetch hongi)
// ===================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID;

const VERSION = "BTC Dashboard v8.3 (Complete JS Port)";
let lastUpdateId = 0;
let lastAnalyticTime = 0;
const CHECK_INTERVAL = 300000; // 5 Minute (in milliseconds)

// --- Dummy HTTP Server (Render Web Service Requirement) ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('BTC Analytical Dashboard Bot is Running 24/7!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Dummy Web Server listening on port ${PORT}`);
});

// --- Telegram Helper Functions ---
async function sendTelegramMessage(message) {
    if (!TELEGRAM_TOKEN || !ALLOWED_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: ALLOWED_CHAT_ID,
            text: message,
            parse_mode: "Markdown"
        }, { timeout: 10000 });
    } catch (error) {
        console.error(`❌ Telegram Send Error: ${error.message}`);
    }
}

async function checkTelegramUpdates() {
    if (!TELEGRAM_TOKEN) return false;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`;
        const response = await axios.get(url, {
            params: { timeout: 1, limit: 5, offset: lastUpdateId + 1 },
            timeout: 5000
        });

        if (response.data && response.data.ok && response.data.result.length > 0) {
            for (const update of response.data.result) {
                lastUpdateId = update.update_id;
                const message = update.message || {};
                const text = message.text || "";
                const chatId = String(message.chat ? message.chat.id : "");

                if (text === "/start" && chatId === String(ALLOWED_CHAT_ID)) {
                    console.log("📩 /start command received from valid chat ID!");
                    return true;
                }
            }
        }
    } catch (error) {
        // Suppress timeout logs to keep console clean
    }
    return false;
}

// --- Native Data Fetching Pipelines ---
async function fetchGateioNative() {
    try {
        const fromTs = Math.floor(Date.now() / 1000) - (5 * 24 * 3600);
        
        const statsRes = await axios.get("https://api.gateio.ws/api/v4/futures/usdt/contract_stats", {
            params: { contract: "BTC_USDT", from: fromTs, interval: "1h", limit: "120" }, timeout: 10000
        });
        const klineRes = await axios.get("https://api.gateio.ws/api/v4/futures/usdt/candlesticks", {
            params: { contract: "BTC_USDT", from: fromTs, interval: "1h", limit: "120" }, timeout: 10000
        });

        let statsRaw = statsRes.data;
        let klineRaw = klineRes.data;

        if (!Array.isArray(statsRaw) || !Array.isArray(klineRaw)) return { data: [], frData: [] };
        statsRaw.sort((a, b) => Number(a.time) - Number(b.time));
        klineRaw.sort((a, b) => Number(a.t) - Number(b.t));

        const klineMap = {};
        for (const k of klineRaw) {
            klineMap[parseInt(Number(k.t))] = { high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c) };
        }

        const data = [];
        let runningCvd = 0.0;
        for (const x of statsRaw) {
            const ts = parseInt(Number(x.time));
            const kData = klineMap[ts];
            if (!kData) continue;

            const buyVol = parseFloat(x.long_taker_size || 0);
            const sellVol = parseFloat(x.short_taker_size || 0);
            const delta = buyVol - sellVol;
            runningCvd += delta;

            data.push({
                time: ts, price: kData.close, high: kData.high, low: kData.low,
                OI_USD: parseFloat(x.open_interest_usd || 0) / 1e9,
                top_lsr: parseFloat(x.top_lsr_size || 1.0),
                long_liq: parseFloat(x.long_liq_usd || 0), short_liq: parseFloat(x.short_liq_usd || 0),
                delta: delta, cvd: runningCvd
            });
        }

        const frRaw = await axios.get("https://api.gateio.ws/api/v4/futures/usdt/funding_rate", {
            params: { contract: "BTC_USDT", limit: "120" }, timeout: 10000
        });
        let frData = [];
        if (Array.isArray(frRaw.data)) {
            frRaw.data.sort((a, b) => Number(a.t) - Number(b.t));
            frData = frRaw.data.map(x => ({ time: Number(x.t), rate: parseFloat(x.r || 0) * 100 }));
        }

        return { data, frData };
    } catch (e) {
        console.error(`❌ Gate.io Fetch Error: ${e.message}`);
        return { data: [], frData: [] };
    }
}

async function fetchBinanceFuturesNative() {
    const B = "https://fapi.binance.com";
    const H = { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 };
    const P = { symbol: "BTCUSDT", period: "1h", limit: "120" };

    const oi = await axios.get(`${B}/futures/data/openInterestHist`, { params: P, ...H });
    const top = await axios.get(`${B}/futures/data/topLongShortAccountRatio`, { params: P, ...H });
    const fr = await axios.get(`${B}/fapi/v1/fundingRate`, { params: { symbol: "BTCUSDT", limit: "100" }, ...H });

    return {
        bnTop: top.data.sort((a, b) => Number(a.timestamp) - Number(b.timestamp)),
        bnFr: fr.data.sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime))
    };
}

async function fetchBinanceSpotNative() {
    const resp = await axios.get("https://api.binance.com/api/v3/klines", {
        params: { symbol: "BTCUSDT", interval: "1h", limit: "48" },
        headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000
    });
    
    const spotData = [];
    let runningSpotCvd = 0.0;
    for (const k of resp.data) {
        const vol = parseFloat(k[5]);
        const takerBuy = parseFloat(k[9]);
        const takerSell = vol - takerBuy;
        const delta = takerBuy - takerSell;
        runningSpotCvd += delta;

        spotData.push({
            time: parseFloat(k[0]) / 1000, close: parseFloat(k[4]),
            spot_vol: vol, taker_buy: takerBuy, taker_sell: takerSell,
            spot_delta: delta, spot_cvd: runningSpotCvd
        });
    }
    return spotData;
}

// --- Deep Mathematical Processing Engine ---
async function runAnalyticsEngine() {
    console.log(`🔄 Execution initialized.`);
    
    const { data: gateDf, frData: gateFr } = await fetchGateioNative();
    if (gateDf.length === 0) return "❌ Fatal Error: Core market data streams are down.";

    let binanceAvailable = false, spotAvailable = false;
    let bnTop = [], bnFr = [], spotDf = [];

    try {
        const bnData = await fetchBinanceFuturesNative();
        bnTop = bnData.bnTop; bnFr = bnData.bnFr;
        binanceAvailable = true;
    } catch (e) { console.log(`⚠️ Binance Futures Stream Offline`); }

    try {
        spotDf = await fetchBinanceSpotNative();
        spotAvailable = true;
    } catch (e) { console.log(`⚠️ Binance Spot Stream Offline`); }

    // Analytics Core Calculations
    const latest = gateDf[gateDf.length - 1];
    const len12 = Math.min(12, gateDf.length);
    const priceChange = latest.price - gateDf[gateDf.length - len12].price;
    const gateFrLatest = gateFr.length > 0 ? gateFr[gateFr.length - 1].rate : 0;

    let aggSmartLsr = latest.top_lsr;
    if (binanceAvailable && bnTop.length > 0 && bnFr.length > 0) {
        const bnLatestTop = parseFloat(bnTop[bnTop.length - 1].longShortRatio);
        const smartGap = Math.abs(bnLatestTop - latest.top_lsr);
        aggSmartLsr = smartGap > 1.0 ? 1.0 : (bnLatestTop * 0.65) + (latest.top_lsr * 0.35);
    }

    // Model 1: Components Scoring
    const len24 = Math.min(24, gateDf.length);
    const len72 = Math.min(72, gateDf.length);
    const ma24 = gateDf.slice(-len24).reduce((s, x) => s + x.price, 0) / len24;
    const ma72 = gateDf.slice(-len72).reduce((s, x) => s + x.price, 0) / len72;

    let c1Label = "NEUTRAL", c1Score = 0;
    if (ma24 > ma72) {
        if (latest.price > ma24) { c1Label = "STRONG BULL"; c1Score = 25; }
        else { c1Label = "BULL"; c1Score = 15; }
    } else if (ma24 < ma72) {
        if (latest.price < ma24) { c1Label = "STRONG BEAR"; c1Score = -25; }
        else { c1Label = "BEAR"; c1Score = -15; }
    }

    // CVD 6H Z-Score calculation
    const deltas6h = gateDf.map((_, i) => gateDf.slice(Math.max(0, i - 5), i + 1).reduce((s, x) => s + x.delta, 0));
    const tailLen = Math.min(48, deltas6h.length);
    const tailDeltas = deltas6h.slice(-tailLen);
    const cvd6hMean = tailDeltas.reduce((s, x) => s + x, 0) / tailLen;
    const cvd6hStd = Math.sqrt(tailDeltas.reduce((s, x) => s + Math.pow(x - cvd6hMean, 2), 0) / tailLen) || 1;
    const cvdZ = (deltas6h[deltas6h.length - 1] - cvd6hMean) / cvd6hStd;

    let c2Label = "NEUTRAL", c2Score = 0;
    if (cvdZ > 1.0) { c2Label = "AGGRESSIVE BUYING"; c2Score = 25; }
    else if (cvdZ > 0.3) { c2Label = "BUYING"; c2Score = 15; }
    else if (cvdZ < -1.0) { c2Label = "AGGRESSIVE SELLING"; c2Score = -25; }
    else if (cvdZ < -0.3) { c2Label = "SELLING"; c2Score = -15; }

    // Open Interest Build-up
    const oiChanges = [];
    for(let i=1; i<gateDf.length; i++) oiChanges.push(gateDf[i].OI_USD - gateDf[i-1].OI_USD);
    const oiTailLen = Math.min(48, oiChanges.length);
    const tailOi = oiChanges.slice(-oiTailLen);
    const oiMean = tailOi.reduce((s, x) => s + x, 0) / oiTailLen || 0;
    const oiStd = Math.sqrt(tailOi.reduce((s, x) => s + Math.pow(x - oiMean, 2), 0) / oiTailLen) || 1;
    const oiZ = (oiChanges[oiChanges.length - 1] - oiMean) / oiStd || 0;

    let c3Label = "NEUTRAL", c3Score = 0;
    if (oiZ > 0.8) {
        if (priceChange > 0) { c3Label = "LONG BUILDUP"; c3Score = 20; }
        else { c3Label = "SHORT BUILDUP"; c3Score = -20; }
    } else if (oiZ < -0.8) {
        if (priceChange < 0) { c3Label = "LONG FLUSH"; c3Score = -10; }
        else { c3Label = "SHORT FLUSH"; c3Score = 10; }
    }

    const totalScore = c1Score + c2Score + c3Score;
    const confidence = Math.min(Math.round((Math.abs(totalScore) / 100) * 100), 100);
    const direction = totalScore >= 40 ? "LONG" : (totalScore <= -40 ? "SHORT" : "NEUTRAL");

    // Model 2: Expansion Engine
    const lookback24h = gateDf.slice(-Math.min(24, gateDf.length));
    const intraHourRanges = lookback24h.map(x => x.high - x.low);
    const atrUsd = intraHourRanges.reduce((s, x) => s + x, 0) / intraHourRanges.length || 500.0;
    const currentRange = latest.high - latest.low;
    const vm = currentRange / atrUsd || 1.0;

    let m2Score = vm >= 2.0 ? 15 : (vm >= 1.0 ? 7 : 0);
    const expansionScore = Math.min(m2Score * 6, 100); 
    const classification = expansionScore > 50 ? "STRONG EXPANSION" : "NORMAL MARKET";

    // Model 3: Triggers & Decisions
    const stableBullTrigger = Math.max(...lookback24h.map(x => x.high));
    const stableBearTrigger = Math.min(...lookback24h.map(x => x.low));
    const setupType = expansionScore >= 41 && direction !== "NEUTRAL" ? direction : "WATCHLIST";
    const action = setupType === "WATCHLIST" ? "MONITOR STRUCTURE" : `ENTER ${setupType}`;

    // 💾 SIMULATED DATA LOG (Render Free persistent disk issue logic bypass)
    console.log(`💾 [CONSOLE LOGGED IN RENDER] | Price: $${latest.price} | Score: ${totalScore} | Expansion: ${expansionScore}`);

    // Return Elegant Telegram Output Report
    return (
        `📊 *BTC COMPLETE REPORT (v8.3)*\n` +
        `🕒 ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} (IST)\n` +
        `─`.repeat(15) + `\n` +
        `💰 *BTC Current Price:* $${latest.price.toLocaleString()}\n` +
        `📈 *Direction Matrix:* \`${direction}\` (Conf: ${confidence}%)\n` +
        `🎛️ *M1 Aggregated Score:* ${totalScore}/100\n` +
        `─`.repeat(15) + `\n` +
        `📊 *Trend Phase:* ${c1Label}\n` +
        `🌊 *CVD Momentum:* ${c2Label} (z: ${cvdZ.toFixed(2)})\n` +
        `🔋 *Open Interest:* ${c3Label}\n` +
        `⚡ *Market Energy:* ${classification} (${expansionScore}/100)\n` +
        `─`.repeat(15) + `\n` +
        `🟢 *Stable Bull Trigger:* $${stableBullTrigger.toLocaleString()}\n` +
        `🔴 *Stable Bear Trigger:* $${stableBearTrigger.toLocaleString()}\n` +
        `🚀 *Recommended Action:* \`${action}\``
    );
}

// ==========================================
// 🔄 24/7 BACKGROUND WORKER SCHEDULER
// ==========================================
async function mainLoop() {
    console.log("🚀 24/7 Deep Processing Engine Engaged...");
    while (true) {
        const currentTime = Date.now();

        // 1. Every 5 minutes: Fetch Data and Print Logs
        if (currentTime - lastAnalyticTime >= CHECK_INTERVAL) {
            console.log("⏰ Running 5-Minute Automated Analytical Evaluation...");
            await runAnalyticsEngine();
            lastAnalyticTime = currentTime;
        }

        // 2. Continuous Check: Telegram Trigger /start Listener (Instant Response)
        const isTriggered = await checkTelegramUpdates();
        if (isTriggered) {
            console.log("⚡ Instant Telegram Request Processing started...");
            const liveReport = await runAnalyticsEngine();
            await sendTelegramMessage(liveReport);
        }

        // 2-second sleep to prevent Event Loop Block / High CPU Throttling
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

mainLoop();
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3787;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const WEATHERAPI_KEY = process.env.WEATHERAPI_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.json': 'application/json; charset=utf-8'
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function noKeyError(res) {
  return sendJSON(res, 500, {
    error: true,
    message: 'WEATHERAPI_KEY is not set on the server. Put WEATHERAPI_KEY=your-key-here in backend/.env'
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function callGemini(prompt, systemInstruction = '') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      generationConfig: { temperature: 0.25 }
    })
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function proxy(res, upstreamUrl) {
  try {
    const upstream = await fetch(upstreamUrl, { signal: AbortSignal.timeout(8000) });
    const data = await upstream.json();
    sendJSON(res, upstream.ok ? 200 : 502, data);
  } catch (err) {
    sendJSON(res, 502, { error: true, message: err.message || 'upstream fetch failed' });
  }
}

function serveStatic(res, rootDir, relativePath) {
  const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(rootDir, safePath);
  if (!fullPath.startsWith(rootDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found: ' + relativePath);
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // LLM / NLP chat endpoint
  /*if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const { query, lang = 'en' } = await parseBody(req);
      if (!query) return sendJSON(res, 400, { error: true, message: 'query is required' });

      let location = 'Delhi';
      if (GEMINI_API_KEY) {
        try {
          const extractionPrompt = `Extract the target Indian city/district/state from this query: "${query}". Reply ONLY with the city/place name. If no city is specified, return "Delhi".`;
          const extracted = await callGemini(extractionPrompt);
          location = extracted.trim().replace(/[^a-zA-Z\s]/g, '') || 'Delhi';
        } catch (e) {
          console.warn('Location extraction fallback:', e.message);
        }
      }

      const weatherUrl = `https://api.weatherapi.com/v1/forecast.json?key=${encodeURIComponent(WEATHERAPI_KEY)}&q=${encodeURIComponent(location)}&days=3&aqi=yes&alerts=yes`;
      const weatherRes = await fetch(weatherUrl);
      const weatherData = await weatherRes.json();

      if (weatherData.error) {
        return sendJSON(res, 200, {
          reply: `Could not fetch live weather for "${location}". Please check the place name.`,
          weatherData: null
        });
      }
  

      const systemInstruction = `You are WeatherGPT, a weather assistant for SIH (Ministry of Earth Sciences / Mission Mausam).
Rules:
1. Base your answer strictly on the provided Weather Context JSON.
2. Provide clear, actionable advice (umbrella, heat, AQI masks).
3. If alerts exist, mention them clearly.
4. Format in clean HTML with <b> tags for temperatures and conditions.
5. Respond in: ${lang === 'hi' ? 'Hindi (हिन्दी)' : 'English'}.`;

      const prompt = `User Question: "${query}"
Weather Context:
${JSON.stringify({
  location: weatherData.location,
  current: weatherData.current,
  forecast: weatherData.forecast?.forecastday,
  alerts: weatherData.alerts?.alert
})}

Provide an advisory response:`;

      let reply = '';
      if (GEMINI_API_KEY) {
        reply = await callGemini(prompt, systemInstruction);
      } else {
        reply = `<b>${weatherData.location.name}</b>: ${weatherData.current.condition.text}, <b>${weatherData.current.temp_c}°C</b>.`;
      }

      return sendJSON(res, 200, { reply, rawWeather: weatherData });
    } catch (err) {
      return sendJSON(res, 500, { error: true, message: err.message });
    }
  }*/
 // Helper to extract city using local list & regex if LLM is unavailable
  function localExtractCity(text) {
    const known = ['delhi','mumbai','chennai','kolkata','bengaluru','bangalore','hyderabad','pune','ahmedabad','jaipur','lucknow','kochi','shimla','patna','bhopal','guwahati','chandigarh','srinagar','goa','panaji','varanasi','indore','nagpur','surat','visakhapatnam','bhubaneswar','ranchi','raipur','dehradun','amritsar','agra','mysuru','puri','darjeeling','jalpaiguri','odisha','siliguri','kerala','assam'];
    const lower = text.toLowerCase();
    for (const c of known) {
      if (lower.includes(c)) return c.charAt(0).toUpperCase() + c.slice(1);
    }
    const m = lower.match(/\b(?:in|for|at|around)\s+([a-zA-Z]+)/);
    if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return 'Delhi';
  }

  // LLM / NLP chat endpoint
// LLM NLP Chat Endpoint
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const { query, lang = 'en' } = await parseBody(req);
      if (!query) return sendJSON(res, 400, { error: true, message: 'query is required' });

      // 1. Resolve Location
      let location = localExtractCity(query);
      if (GEMINI_API_KEY) {
        try {
          const extractionPrompt = `Extract ONLY the Indian city, district, or state name from this inquiry: "${query}". Assume all locations refer to India (e.g. "Delhi" means "Delhi, India", not Ontario or USA). Output ONLY the place name. If none is found, return "Delhi".`;
          const extracted = await callGemini(extractionPrompt);
          const clean = extracted.trim().replace(/[^a-zA-Z\s]/g, '');
          if (clean) location = clean;
        } catch (e) {
          console.warn('[Extraction] Gemini fallback:', e.message);
        }
      }

      const cleanPlace = location.replace(/,\s*india/gi, '').trim();
      const queryLocation = `${cleanPlace}, India`;
      console.log(`[Chat] Query: "${query}" → Target: "${queryLocation}"`);

      // 2. Fetch live data
      const weatherUrl = `https://api.weatherapi.com/v1/forecast.json?key=${encodeURIComponent(WEATHERAPI_KEY)}&q=${encodeURIComponent(queryLocation)}&days=3&aqi=yes&alerts=yes`;
      const weatherRes = await fetch(weatherUrl);
      const weatherData = await weatherRes.json();

      if (weatherData.error) {
        return sendJSON(res, 200, {
          reply: `Could not fetch live weather data for <b>${location}</b> (${weatherData.error.message || 'location not found'}).`,
          rawWeather: null
        });
      }

      // 3. Grounded Synthesis Prompt
      const systemInstruction = `You are WeatherGPT, an authoritative conversational climate and alert assistant designed for SIH (Ministry of Earth Sciences / Mission Mausam).
Rules:
1. Answer the query directly using ONLY the facts provided in the Weather Context JSON.
2. Never invent temperature, humidity, wind, or alert values.
3. Provide practical advisory guidance (e.g., umbrella advice for rain chance, masks for elevated AQI, heat precautions).
4. Emphasize important values using HTML <b> tags.
5. Respond in: ${lang === 'hi' ? 'Hindi (हिन्दी)' : 'English'}.`;

      const prompt = `User Query: "${query}"
Weather Context:
${JSON.stringify({
  location: weatherData.location,
  current: weatherData.current,
  forecast: weatherData.forecast?.forecastday,
  alerts: weatherData.alerts?.alert
})}

Provide a concise, direct advisory response:`;

      let reply = '';
      if (GEMINI_API_KEY) {
        try {
          reply = await callGemini(prompt, systemInstruction);
        } catch (llmErr) {
          console.error('Gemini call error:', llmErr.message);
          reply = `<b>${weatherData.location.name} (${weatherData.location.region})</b>: ${weatherData.current.condition.text}, <b>${weatherData.current.temp_c}°C</b>, Wind: <b>${weatherData.current.wind_kph} km/h ${weatherData.current.wind_dir}</b>.`;
        }
      } else {
        reply = `<b>${weatherData.location.name} (${weatherData.location.region})</b>: ${weatherData.current.condition.text}, <b>${weatherData.current.temp_c}°C</b>, Wind: <b>${weatherData.current.wind_kph} km/h ${weatherData.current.wind_dir}</b>.`;
      }

      return sendJSON(res, 200, { reply, rawWeather: weatherData });
    } catch (err) {
      console.error('Chat endpoint error:', err);
      return sendJSON(res, 500, { error: true, message: err.message });
    }
  }

  // Geocode proxy
  if (url.pathname === '/api/geocode') {
    if (!WEATHERAPI_KEY) return noKeyError(res);
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) return sendJSON(res, 400, { error: true, message: 'missing name parameter' });
    const target = `https://api.weatherapi.com/v1/search.json?key=${encodeURIComponent(WEATHERAPI_KEY)}&q=${encodeURIComponent(name)}`;
    return proxy(res, target);
  }

  // Weather proxy
  if (url.pathname === '/api/weather') {
    if (!WEATHERAPI_KEY) return noKeyError(res);
    const location = (url.searchParams.get('location') || '').trim();
    if (!location) return sendJSON(res, 400, { error: true, message: 'missing location parameter' });
    const lang = url.searchParams.get('lang') || 'en';
    const target = `https://api.weatherapi.com/v1/forecast.json?key=${encodeURIComponent(WEATHERAPI_KEY)}&q=${encodeURIComponent(location)}&days=3&aqi=yes&alerts=yes&lang=${encodeURIComponent(lang)}`;
    return proxy(res, target);
  }

  // Static files
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveStatic(res, FRONTEND_DIR, 'index.html');
  }
  if (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
    return serveStatic(res, FRONTEND_DIR, url.pathname);
  }
  if (url.pathname.startsWith('/assets/')) {
    return serveStatic(res, ASSETS_DIR, url.pathname.replace(/^\/assets\//, ''));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use by another process. Run: netstat -ano | findstr :${PORT}`);
  } else {
    console.error('Server failed to start:', err);
  }
});

server.listen(PORT, () => {
  console.log(`WeatherGPT server running → http://localhost:${PORT}`);
  console.log(`Serving frontend from: ${FRONTEND_DIR}`);
});
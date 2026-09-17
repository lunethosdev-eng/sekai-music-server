require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const ytSearch = require('yt-search');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || 'https://sekai-music-server.onrender.com';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'sekai_secret_key_123';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Caché para el catálogo completo (5 minutos de TTL)
const catalogCache = new NodeCache({ stdTTL: 300 });

let soundcloudClientId = 'iZea6V13B2S91I1B1i0x90nI0N6N9p6a';

// Auxiliar para retardar peticiones y evitar bloqueo de IP (Rate Limiting)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Middleware de autenticación simple para endpoints sensibles
const requireAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === ADMIN_API_KEY) {
        return next();
    }
    return res.status(401).json({ status: 'error', message: 'No autorizado. Se requiere x-api-key válida.' });
};

// Obtener Client ID dinámico de SoundCloud
async function getSoundCloudClientId() {
    try {
        const pageRes = await axios.get('https://soundcloud.com', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 5000
        });
        const jsUrls = pageRes.data.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9-]+\.js/g) || [];
        for (const url of jsUrls.slice(-4)) {
            const jsRes = await axios.get(url, { timeout: 5000 });
            const match = jsRes.data.match(/client_id\s*:\s*["']([a-zA-Z0-9]{32})["']/);
            if (match && match[1]) {
                soundcloudClientId = match[1];
                return soundcloudClientId;
            }
        }
    } catch (e) {
        console.error('Error obteniendo SoundCloud Client ID:', e.message);
    }
    return soundcloudClientId;
}

// Búsqueda masiva en SoundCloud
async function searchSoundCloud(query) {
    try {
        const clientId = await getSoundCloudClientId();
        const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=50`;
        const res = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 6000
        });

        if (res.data && res.data.collection) {
            return res.data.collection.map(t => ({
                title: t.title,
                artist: t.user ? t.user.username : 'SoundCloud Artist',
                duration: Math.floor((t.duration || 180000) / 1000),
                source: 'soundcloud',
                audio_url: t.permalink_url,
                cover_url: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : (t.user ? t.user.avatar_url : null)
            })).filter(t => t.duration >= 45 && t.audio_url);
        }
    } catch (e) {
        console.error(`Error en búsqueda SoundCloud (${query}):`, e.message);
    }
    return [];
}

// Búsqueda masiva en YouTube
async function searchYouTube(query) {
    try {
        const r = await ytSearch(query);
        const videos = r.videos || [];
        return videos.map(v => ({
            title: v.title,
            artist: v.author ? v.author.name.replace('VEVO', '').replace('- Topic', '').trim() : 'YouTube Artist',
            duration: v.duration.seconds,
            source: 'youtube',
            audio_url: v.url,
            cover_url: v.thumbnail
        })).filter(v => v.duration >= 45 && v.audio_url);
    } catch (e) {
        console.error(`Error en búsqueda YouTube (${query}):`, e.message);
    }
    return [];
}

const searchTargets = [
    { genre: "Eve", query: "Eve ooo0eve0ooo Kaikai Kitan" },
    { genre: "Eve", query: "Eve Dramaturgy Fight Song" },
    { genre: "Eve", query: "Eve Anoko Secret Outsider" },
    { genre: "Eve", query: "Eve Bokura no Mai Gunjo Sanka" },
    { genre: "Eve", query: "Eve official music audio" },
    { genre: "Trío Los Panchos", query: "Trio Los Panchos Sabor a mi" },
    { genre: "Trío Los Panchos", query: "Trio Los Panchos Si tu me dices ven" },
    { genre: "Trío Los Panchos", query: "Trio Los Panchos Sin ti Caminemos" },
    { genre: "Trío Los Panchos", query: "Trio Los Panchos Rayito de luna" },
    { genre: "Trío Los Panchos", query: "Trio Los Panchos Historia de un amor" },
    { genre: "Trío Los Panchos", query: "Trio Los Panchos boleros clasicos" },
    { genre: "Cuarteto de Nos", query: "Cuarteto de Nos Porfiado Raro" },
    { genre: "Cuarteto de Nos", query: "Cuarteto de Nos Jueves Bipolar" },
    { genre: "Depresión Sonora", query: "Depresion Sonora canciones" },
    { genre: "Laufey", query: "Laufey jazz indie tracks" },
    { genre: "Post-Punk", query: "Post-Punk Russian Spanish" },
    { genre: "Post-Punk", query: "Molchat Doma Ploho Human Tetris" },
    { genre: "City Pop", query: "80s Japanese City Pop hits" },
    { genre: "City Pop", query: "Miki Matsubara Tatsuro Yamashita Mariya Takeuchi" },
    { genre: "Boleros", query: "Boleros del recuerdo clasicos" },
    { genre: "Indie Rock", query: "Indie rock top hits classic" },
    { genre: "Arctic Monkeys", query: "Arctic Monkeys full tracks" },
    { genre: "The Strokes", query: "The Strokes full tracks" },
    { genre: "Gorillaz", query: "Gorillaz official music tracks" },
    { genre: "Tame Impala", query: "Tame Impala full tracks" },
    { genre: "Radiohead", query: "Radiohead full album tracks" },
    { genre: "Deftones", query: "Deftones tracks audio" },
    { genre: "Cigarettes After Sex", query: "Cigarettes After Sex tracks" },
    { genre: "TV Girl", query: "TV Girl songs album" },
    { genre: "Mitski", query: "Mitski full songs" },
    { genre: "Clairo", query: "Clairo indie songs" },
    { genre: "Synthwave", query: "Synthwave retrowave 80s" },
    { genre: "Lofi Beats", query: "Lofi hip hop relaxing beats" },
    { genre: "Shoegaze", query: "Shoegaze dream pop tracks" },
    { genre: "Darkwave", query: "Darkwave goth tracks" },
    { genre: "Midwest Emo", query: "Midwest emo indie rock" },
    { genre: "Anime OST", query: "Anime openings full official" },
    { genre: "J-Pop", query: "J-Pop top chart hits Yoasobi Ado Kenshi Yonezu" },
    { genre: "Phonk", query: "Drift phonk aggressive house" },
    { genre: "Vaporwave", query: "Vaporwave aesthetic music" },
    { genre: "Rock en Español", query: "Rock en espanol 80s 90s clasicos" },
    { genre: "Pop Punk", query: "Pop punk 2000s classic hits" }
];

// Anti-sleep Ping
setInterval(async () => {
    try {
        await axios.get(`${RENDER_URL}/api/health`);
    } catch (e) {}
}, 10 * 60 * 1000);

app.get('/api/health', (req, res) => res.status(200).send('OK - Server Active'));

// INGESTA MASIVA MEJORADA CON UPSERT Y RATE LIMITING
async function runMassiveScraper() {
    console.log('🚀 [SCRAPER] Iniciando descarga masiva desde SoundCloud + YouTube...');

    try {
        let insertedCount = 0;

        for (const target of searchTargets) {
            console.log(`🔎 Escaneando: [${target.genre}] -> "${target.query}"`);

            const [scTracks, ytTracks] = await Promise.all([
                searchSoundCloud(target.query),
                searchYouTube(target.query)
            ]);

            const allTracks = [...scTracks, ...ytTracks];
            const batchToInsert = [];

            for (const track of allTracks) {
                // Limpieza de título mejorada
                const cleanTitle = track.title
                    .replace(/\[.*\]|\(.*\)/g, '')
                    .replace(/Official Video|Official Audio|Video Oficial|Lyric Video|Audio|4K|HD|Remastered|Full Song/gi, '')
                    .trim();

                batchToInsert.push({
                    title: cleanTitle || track.title,
                    artist: track.artist || target.genre,
                    genre: target.genre,
                    duration: track.duration,
                    source: track.source,
                    audio_url: track.audio_url,
                    cover_url: track.cover_url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=500&q=80',
                    lyrics: "[00:00.00] Letra no disponible"
                });
            }

            // Uso de UPSERT ignorando duplicados por audio_url (requiere Unique Constraint en Supabase)
            if (batchToInsert.length > 0) {
                const { data, error } = await supabase
                    .from('songs')
                    .upsert(batchToInsert, { onConflict: 'audio_url', ignoreDuplicates: true })
                    .select();

                if (!error) {
                    const added = data ? data.length : 0;
                    insertedCount += added;
                    console.log(`✅ +${added} canciones nuevas agregadas de [${target.genre}].`);
                } else {
                    console.error('Error insertando lote:', error.message);
                }
            }

            // Pausa de 1.5 segundos entre búsquedas para evitar Rate Limit
            await delay(1500);
        }

        // Limpiar caché del catálogo tras actualización
        catalogCache.del('full_catalog');
        console.log(`🎉 [SCRAPER] Escaneo terminado. Novedades agregadas: ${insertedCount}.`);
    } catch (e) {
        console.error('Error en scraper masivo:', e.message);
    }
}

cron.schedule('*/15 * * * *', () => {
    console.log('⏰ Ejecutando escaneo programado cada 15 minutos...');
    runMassiveScraper();
});

// ENDPOINT DEL CATÁLOGO CON CACHÉ EN MEMORIA (Mantiene entrega masiva sin paginación)
app.get('/api/v1/catalog', async (req, res) => {
    try {
        const cachedCatalog = catalogCache.get('full_catalog');
        if (cachedCatalog) {
            return res.json({
                status: 'success',
                server: RENDER_URL,
                cached: true,
                total: cachedCatalog.length,
                catalog: cachedCatalog
            });
        }

        const { data, error } = await supabase
            .from('songs')
            .select('*')
            .range(0, 9999)
            .order('id', { ascending: false });

        if (error) return res.status(500).json({ status: 'error', message: error.message });

        catalogCache.set('full_catalog', data);

        res.json({
            status: 'success',
            server: RENDER_URL,
            cached: false,
            total: data.length,
            catalog: data
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// NUEVO ENDPOINT DE BÚSQUEDA EN TIEMPO REAL EN LA BASE DE DATOS
app.get('/api/v1/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ status: 'error', message: 'Se requiere parámetro ?q=' });

        const { data, error } = await supabase
            .from('songs')
            .select('*')
            .or(`title.ilike.%${q}%,artist.ilike.%${q}%,genre.ilike.%${q}%`)
            .limit(50);

        if (error) return res.status(500).json({ status: 'error', message: error.message });

        res.json({ status: 'success', total: data.length, results: data });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Endpoint de respaldo
app.get('/api/songs', async (req, res) => {
    const cachedCatalog = catalogCache.get('full_catalog');
    if (cachedCatalog) return res.json(cachedCatalog);

    const { data } = await supabase.from('songs').select('*').range(0, 9999).order('id', { ascending: false });
    res.json(data || []);
});

// Carga manual protegida por clave API
app.post('/api/upload', requireAuth, async (req, res) => {
    try {
        const { title, artist, duration, audio_url, cover_url, lyrics, genre } = req.body;
        const songData = {
            title,
            artist,
            genre: genre || 'General',
            duration: parseInt(duration) || 180,
            source: 'manual',
            audio_url: audio_url || '',
            cover_url: cover_url || '',
            lyrics: lyrics || null
        };
        const { data, error } = await supabase.from('songs').insert([songData]).select();
        if (error) return res.status(500).json({ error: error.message });

        catalogCache.del('full_catalog');
        res.json({ success: true, song: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    runMassiveScraper();
});

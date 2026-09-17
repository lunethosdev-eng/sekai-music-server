require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const ytSearch = require('yt-search');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || 'https://sekai-music-server.onrender.com';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let soundcloudClientId = null;

// Obtener Client ID público de SoundCloud dinámicamente
async function getSoundCloudClientId() {
    if (soundcloudClientId) return soundcloudClientId;
    try {
        const pageRes = await axios.get('https://soundcloud.com', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const jsUrls = pageRes.data.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9-]+\.js/g) || [];
        for (const url of jsUrls.slice(-3)) {
            const jsRes = await axios.get(url);
            const match = jsRes.data.match(/client_id\s*:\s*["']([a-zA-Z0-9]{32})["']/);
            if (match && match[1]) {
                soundcloudClientId = match[1];
                console.log('✅ Token SoundCloud obtenido:', soundcloudClientId);
                return soundcloudClientId;
            }
        }
    } catch (e) {
        console.error('Error obteniendo token SoundCloud:', e.message);
    }
    return null;
}

// Búsqueda en SoundCloud (PRINCIPAL)
async function searchSoundCloud(query) {
    try {
        const clientId = await getSoundCloudClientId();
        if (!clientId) return [];

        const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=25`;
        const res = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        if (res.data && res.data.collection) {
            return res.data.collection.map(t => ({
                title: t.title,
                artist: t.user ? t.user.username : 'SoundCloud Artist',
                duration: Math.floor((t.duration || 180000) / 1000),
                source: 'soundcloud',
                audio_url: t.permalink_url,
                cover_url: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : (t.user ? t.user.avatar_url : null)
            })).filter(t => t.duration >= 60); // Omitir audios < 60s
        }
    } catch (e) {
        console.error(`SoundCloud error (${query}):`, e.message);
    }
    return [];
}

// Búsqueda en YouTube (BACKUP)
async function searchYouTubeBackup(query) {
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
        })).filter(v => v.duration >= 60);
    } catch (e) {
        console.error(`YouTube Backup error (${query}):`, e.message);
    }
    return [];
}

// Búsqueda de Letras Sincronizadas
async function searchLyrics(title, artist) {
    try {
        const cleanTitle = title.replace(/\(.*\)|\[.*\]/g, '').trim();
        const response = await axios.get(`https://lrclib.net/api/search`, {
            params: { track_name: cleanTitle, artist_name: artist },
            timeout: 2500
        });
        if (response.data && response.data.length > 0) {
            const match = response.data[0];
            return match.syncedLyrics || match.plainLyrics || null;
        }
    } catch (e) {}
    return null;
}

// Lista masiva de objetivos de búsqueda
const searchTargets = [
    // ARTISTAS SOLICITADOS
    { name: "Eve", query: "Eve ooo0eve0ooo official music" },
    { name: "Eve", query: "Eve Kaikai Kitan Dramaturgy Anoko Secret" },
    { name: "Trío Los Panchos", query: "Trio Los Panchos boleros clasicos" },
    { name: "Trío Los Panchos", query: "Trio Los Panchos Si tu me dices ven Sabor a mi" },

    // OTROS ARTISTAS Y GÉNEROS
    { name: "Depresión Sonora", query: "Depresion Sonora canciones" },
    { name: "Laufey", query: "Laufey jazz indie tracks" },
    { name: "Post-Punk", query: "Post-Punk indie Russian Spanish songs" },
    { name: "City Pop", query: "80s Japanese City Pop hits" },
    { name: "Boleros", query: "Boleros del recuerdo clasicos" },
    { name: "Indie Rock", query: "Indie rock top hits" },
    { name: "Synthwave", query: "Synthwave retrowave instrumental tracks" },
    { name: "Lofi Beats", query: "Lofi hip hop beats relaxing" },
    { name: "Shoegaze", query: "Shoegaze dream pop music" },
    { name: "Darkwave", query: "Darkwave goth songs" },
    { name: "Anime OST", query: "Anime opening themes full" },
    { name: "J-Pop", query: "J-Pop top chart hits" },
    { name: "Cuarteto de Nos", query: "Cuarteto de Nos canciones" },
    { name: "Grupo Frontera", query: "Grupo Frontera canciones" },
    { name: "The Strokes", query: "The Strokes tracks" },
    { name: "Arctic Monkeys", query: "Arctic Monkeys full tracks" }
];

// Anti-sleep Ping
setInterval(async () => {
    try {
        await axios.get(`${RENDER_URL}/api/health`);
        console.log('⚡ Ping enviando a Render...');
    } catch (e) {}
}, 13 * 60 * 1000);

app.get('/api/health', (req, res) => res.status(200).send('OK - Server Active'));

// INGESTA MASIVA: SoundCloud (Principal) -> YouTube (Backup)
async function runMassiveScraper() {
    console.log('🚀 Iniciando escaneo masivo (SoundCloud -> YouTube Backup)...');

    for (const target of searchTargets) {
        try {
            console.log(`🔎 Escaneando: [${target.name}] - Query: "${target.query}"`);
            
            // 1. Intentar en SoundCloud primero
            let tracks = await searchSoundCloud(target.query);
            
            // 2. Si SoundCloud devuelve menos de 5 resultados, usar YouTube como respaldo
            if (!tracks || tracks.length < 5) {
                console.log(`⚠️ SoundCloud con pocos resultados para ${target.name}. Activando backup de YouTube...`);
                const ytTracks = await searchYouTubeBackup(target.query);
                tracks = [...tracks, ...ytTracks];
            }

            for (const track of tracks) {
                const cleanTitle = track.title
                    .replace(/\[.*\]|\(.*\)/g, '')
                    .replace(/Official Video|Official Audio|Video Oficial|Lyric Video|Audio/gi, '')
                    .trim();

                // Validación de duplicados por URL exacta
                const { data: existing } = await supabase
                    .from('songs')
                    .select('id')
                    .eq('audio_url', track.audio_url)
                    .maybeSingle();

                if (existing) continue;

                const lyrics = await searchLyrics(cleanTitle, track.artist);

                const songData = {
                    title: cleanTitle || track.title,
                    artist: track.artist || target.name,
                    genre: target.name,
                    duration: track.duration,
                    source: track.source,
                    audio_url: track.audio_url,
                    cover_url: track.cover_url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=500&q=80',
                    lyrics: lyrics || "[00:00.00] Letra no disponible"
                };

                const { error } = await supabase.from('songs').insert([songData]);
                if (!error) console.log(`+ Agregada [${track.source.toUpperCase()}]: ${cleanTitle} - ${track.artist}`);
            }
        } catch (e) {
            console.error(`Error escaneando ${target.name}:`, e.message);
        }
    }
    console.log('🎉 Proceso de ingesta finalizado.');
}

// Cron Job: Escaneo cada 2 horas
cron.schedule('0 */2 * * *', () => {
    runMassiveScraper();
});

// ==========================================
// UNIFIED SINGLE ENDPOINT FOR THE CATALOG
// ==========================================
// Este endpoint único devuelve todo el catálogo sin necesidad de múltiples llamadas
app.get('/api/v1/catalog', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('songs')
            .select('*')
            .order('id', { ascending: false })
            .limit(2000);

        if (error) return res.status(500).json({ status: 'error', message: error.message });

        res.json({
            status: 'success',
            server: RENDER_URL,
            total: data.length,
            catalog: data
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Compatibilidad con endpoint legacy
app.get('/api/songs', async (req, res) => {
    const { data } = await supabase.from('songs').select('*').order('id', { ascending: false }).limit(2000);
    res.json(data || []);
});

// Subida manual
app.post('/api/upload', async (req, res) => {
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
        res.json({ success: true, song: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    runMassiveScraper();
});

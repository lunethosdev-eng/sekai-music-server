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
const RENDER_URL = process.env.RENDER_URL || `http://localhost:${PORT}`;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Categorías, Géneros y Artistas objetivo para superar las 1,000 canciones
const searchTargets = [
    // Géneros y Estilos
    { name: "Post-Punk", query: "Post Punk indie songs official audio" },
    { name: "Indie Rock", query: "Indie Rock hits playlist audio" },
    { name: "Synthwave", query: "Synthwave retrowave 80s full track" },
    { name: "City Pop", query: "Japanese City Pop 80s track" },
    { name: "Lofi Beats", query: "Lofi hip hop beats relaxing track" },
    { name: "Anime OST", query: "Anime opening full song official" },
    { name: "J-Pop Hits", query: "J-Pop top songs audio" },
    { name: "Alt Rock", query: "Alternative Rock top tracks" },
    { name: "Latin Indie", query: "Indie en espanol canciones top" },
    { name: "Pop Punk", query: "Pop punk classic songs audio" },
    { name: "Shoegaze", query: "Shoegaze dream pop tracks" },
    { name: "Darkwave", query: "Darkwave goth tracks" },
    { name: "K-Pop", query: "K-Pop hits audio official" },
    
    // Artistas Específicos
    { name: "Depresión Sonora", query: "Depresion Sonora canciones audio" },
    { name: "Eve", query: "Eve official music audio" },
    { name: "Laufey", query: "Laufey songs official" },
    { name: "Grupo Frontera", query: "Grupo Frontera canciones" },
    { name: "Kenshi Yonezu", query: "Kenshi Yonezu songs" },
    { name: "Arctic Monkeys", query: "Arctic Monkeys tracks" },
    { name: "Joji", query: "Joji audio track" },
    { name: "Ado", query: "Ado official songs" },
    { name: "Yoasobi", query: "Yoasobi full tracks" },
    { name: "Cuarteto de Nos", query: "Cuarteto de Nos canciones" },
    { name: "The Strokes", query: "The Strokes full tracks" },
    { name: "Gorillaz", query: "Gorillaz tracks" },
    { name: "Tame Impala", query: "Tame Impala tracks" }
];

// Anti-sleep Ping para Render cada 13 min
setInterval(async () => {
    try {
        await axios.get(`${RENDER_URL}/api/health`);
        console.log('⚡ Ping de reactivación enviado');
    } catch (error) {
        console.error('Error en ping:', error.message);
    }
}, 13 * 60 * 1000);

app.get('/api/health', (req, res) => res.status(200).send('OK - Server Live'));

// Búsqueda de letras sincronizadas en LRCLIB
async function searchLyrics(title, artist) {
    try {
        const cleanTitle = title.replace(/\(.*\)|\[.*\]/g, '').trim();
        const response = await axios.get(`https://lrclib.net/api/search`, {
            params: { track_name: cleanTitle, artist_name: artist },
            timeout: 3000
        });
        if (response.data && response.data.length > 0) {
            const match = response.data[0];
            return match.syncedLyrics || match.plainLyrics || null;
        }
    } catch (e) {}
    return null;
}

// Búsqueda de carátulas en iTunes HD
async function searchArtwork(title, artist) {
    try {
        const cleanTitle = title.replace(/\(.*\)|\[.*\]/g, '').trim();
        const res = await axios.get(`https://itunes.apple.com/search`, {
            params: { term: `${artist} ${cleanTitle}`, entity: 'song', limit: 1 },
            timeout: 3000
        });
        if (res.data.results && res.data.results.length > 0) {
            const track = res.data.results[0];
            return track.artworkUrl100 ? track.artworkUrl100.replace('100x100bb', '800x800bb') : null;
        }
    } catch (e) {}
    return null;
}

// Ingesta Masiva por Géneros / Objetivos (Meta > 1000 canciones)
async function runMassiveScraper() {
    console.log('🚀 Iniciando escaneo masivo por géneros y artistas (Objetivo: 1,000+ canciones)...');

    for (const target of searchTargets) {
        try {
            console.log(`🔎 Escaneando categoría: [${target.name}]...`);
            const r = await ytSearch(target.query);
            const videos = r.videos || [];

            for (const video of videos.slice(0, 20)) { // 20 canciones por categoría
                const durationSeconds = video.duration.seconds;

                // Descartar audios de menos de 60 segundos
                if (durationSeconds < 60) continue;

                const cleanTitle = video.title
                    .replace(/\[.*\]|\(.*\)/g, '')
                    .replace(/Official Audio|Official Music Video|Video Oficial|Lyric Video|Audio/gi, '')
                    .trim();

                const artistName = video.author.name.replace('VEVO', '').replace('- Topic', '').trim() || target.name;

                // Verificar duplos en DB
                const { data: existing } = await supabase
                    .from('songs')
                    .select('id')
                    .ilike('title', `%${cleanTitle}%`)
                    .maybeSingle();

                if (existing) continue;

                const coverUrl = await searchArtwork(cleanTitle, artistName);
                const lyrics = await searchLyrics(cleanTitle, artistName);

                const songData = {
                    title: cleanTitle || video.title,
                    artist: artistName,
                    genre: target.name,
                    duration: durationSeconds,
                    source: 'youtube',
                    audio_url: video.url,
                    cover_url: coverUrl || video.thumbnail,
                    lyrics: lyrics || "[00:00.00] Letra no disponible"
                };

                const { error } = await supabase.from('songs').insert([songData]);
                if (!error) console.log(`+ Agregada [${target.name}]: ${cleanTitle}`);
            }
        } catch (e) {
            console.error(`Error escaneando ${target.name}:`, e.message);
        }
    }
    console.log('🎉 Escaneo masivo finalizado.');
}

// Cron Job: Ejecuta el escaneo automáticamente cada 2 horas
cron.schedule('0 */2 * * *', () => {
    console.log('⏰ Ejecutando escaneo programado...');
    runMassiveScraper();
});

// Rutas de API
app.get('/api/songs', async (req, res) => {
    try {
        let query = supabase.from('songs').select('*').order('id', { ascending: false }).limit(1000);
        if (req.query.genre) query = query.ilike('genre', `%${req.query.genre}%`);
        if (req.query.search) query = query.or(`title.ilike.%${req.query.search}%,artist.ilike.%${req.query.search}%`);
        
        const { data, error } = await query;
        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload', async (req, res) => {
    try {
        const { title, artist, duration, audio_url, cover_url, lyrics, genre } = req.body;
        if (!title || !artist) return res.status(400).json({ error: "Título y artista requeridos" });

        const songData = {
            title,
            artist,
            genre: genre || 'Indie',
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
    console.log(`Server listo en puerto ${PORT}`);
    runMassiveScraper(); // Ejecución masiva inicial
});

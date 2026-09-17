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

// Lista ampliada de Artistas para catálogo masivo
const targetArtists = [
    "Depresión Sonora", "Eve", "Laufey", "Grupo Frontera", "Al Hars", 
    "Kenshi Yonezu", "Arctic Monkeys", "Joji", "Ado", "Yoasobi", "Cuarteto de Nos"
];

// Anti-sleep Ping para Render cada 13 min
setInterval(async () => {
    try {
        await axios.get(`${RENDER_URL}/api/health`);
        console.log('⚡ Ping interno enviado a Render');
    } catch (error) {
        console.error('Error en ping interno:', error.message);
    }
}, 13 * 60 * 1000);

app.get('/api/health', (req, res) => res.status(200).send('OK - Sekai Server Live'));

// Búsqueda de letras sincronizadas en LRCLIB
async function searchLyrics(title, artist) {
    try {
        const cleanTitle = title.replace(/\(.*\)|\[.*\]/g, '').trim();
        const response = await axios.get(`https://lrclib.net/api/search`, {
            params: { track_name: cleanTitle, artist_name: artist },
            timeout: 4000
        });
        if (response.data && response.data.length > 0) {
            const match = response.data[0];
            return match.syncedLyrics || match.plainLyrics || null;
        }
    } catch (e) {
        // Fallback silencioso
    }
    return null;
}

// Búsqueda de Carátulas HD e Info de Artista en iTunes
async function searchArtworkAndPhoto(title, artist) {
    try {
        const cleanTitle = title.replace(/\(.*\)|\[.*\]/g, '').trim();
        const res = await axios.get(`https://itunes.apple.com/search`, {
            params: { term: `${artist} ${cleanTitle}`, entity: 'song', limit: 1 },
            timeout: 4000
        });
        if (res.data.results && res.data.results.length > 0) {
            const track = res.data.results[0];
            const highResCover = track.artworkUrl100 ? track.artworkUrl100.replace('100x100bb', '1000x1000bb') : null;
            return {
                cover_url: highResCover,
                artist_photo: track.artworkUrl100 ? track.artworkUrl100.replace('100x100bb', '600x600bb') : null
            };
        }
    } catch (e) {
        // Fallback silencioso
    }
    return { cover_url: null, artist_photo: null };
}

// Ingesta Masiva por Artista (Hasta 35 canciones por artista)
async function scrapeArtistMusic(artist) {
    console.log(`🔍 Búsqueda profunda para: ${artist}...`);
    const searchQueries = [
        `${artist} official audio`,
        `${artist} top songs`,
        `${artist} discografía track`
    ];

    for (const query of searchQueries) {
        try {
            const r = await ytSearch(query);
            const videos = r.videos || [];

            for (const video of videos.slice(0, 12)) {
                const durationSeconds = video.duration.seconds;

                // FILTRO ESTRICTO: Descartar audios menores a 60 segundos
                if (durationSeconds < 60) {
                    console.log(`⏩ Omitida (<60s): ${video.title}`);
                    continue;
                }

                const cleanTitle = video.title
                    .replace(/\[.*\]|\(.*\)/g, '')
                    .replace(/Official Audio|Official Music Video|Video Oficial|Lyric Video/gi, '')
                    .trim();

                // Verificar si ya existe en Supabase
                const { data: existing } = await supabase
                    .from('songs')
                    .select('id')
                    .ilike('title', `%${cleanTitle}%`)
                    .maybeSingle();

                if (existing) {
                    continue;
                }

                const artwork = await searchArtworkAndPhoto(cleanTitle, artist);
                const lyrics = await searchLyrics(cleanTitle, artist);

                const songData = {
                    title: cleanTitle || video.title,
                    artist: artist,
                    duration: durationSeconds,
                    source: 'youtube',
                    audio_url: video.url, // URL de fuente
                    cover_url: artwork.cover_url || video.thumbnail,
                    animated_cover: null,
                    lyrics: lyrics || "[00:00.00] Letra no disponible en sincronía",
                    artist_photo: artwork.artist_photo || video.thumbnail
                };

                const { error } = await supabase.from('songs').insert([songData]);
                if (error) console.error(`❌ Error al insertar ${cleanTitle}:`, error.message);
                else console.log(`✅ Agregada [${artist}]: ${cleanTitle}`);
            }
        } catch (e) {
            console.error(`Error en query "${query}":`, e.message);
        }
    }
}

async function runScraperWorkflow() {
    console.log('🚀 Iniciando escaneo masivo (>200 canciones objetivo)...');
    for (const artist of targetArtists) {
        await scrapeArtistMusic(artist);
    }
    console.log('🎉 Escaneo completado.');
}

// CRON JOB: Cambiado a CADA 2 HORAS
cron.schedule('0 */2 * * *', () => {
    console.log('⏰ Ejecutando escaneo programado de 2 horas...');
    runScraperWorkflow();
});

// ENDPOINTS API
app.get('/api/songs', async (req, res) => {
    try {
        let query = supabase.from('songs').select('*').order('id', { ascending: false });
        if (req.query.artist) query = query.ilike('artist', `%${req.query.artist}%`);
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
        const { title, artist, duration, audio_url, cover_url, animated_cover, lyrics, artist_photo } = req.body;
        
        if (!title || !artist) return res.status(400).json({ error: "Título y artista obligatorios." });
        if (duration && parseInt(duration) < 60) return res.status(400).json({ error: "Debe durar al menos 60s." });

        const songData = {
            title,
            artist,
            duration: parseInt(duration) || 180,
            source: 'manual',
            audio_url: audio_url || '',
            cover_url: cover_url || '',
            animated_cover: animated_cover || null,
            lyrics: lyrics || null,
            artist_photo: artist_photo || null
        };

        const { data, error } = await supabase.from('songs').insert([songData]).select();
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, song: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Sekai Music Server corriendo en puerto ${PORT}`);
    runScraperWorkflow(); // Ejecución inmediata al iniciar
});

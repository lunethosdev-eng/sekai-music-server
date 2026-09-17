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

const targetArtists = [
    "Depresión Sonora", "Eve", "Laufey", "Grupo Frontera", "Al Hars", 
    "Kenshi Yonezu", "Arctic Monkeys", "Joji"
];

// Anti-sleep Ping cada 13 minutos para Render
setInterval(async () => {
    try {
        await axios.get(`${RENDER_URL}/api/health`);
        console.log('⚡ Ping interno enviado para mantener activo Render');
    } catch (error) {
        console.error('Error en ping interno:', error.message);
    }
}, 13 * 60 * 1000);

app.get('/api/health', (req, res) => res.status(200).send('OK - Sekai Music Server Active'));

// Buscar Lyrics en LRCLIB
async function searchLyrics(title, artist) {
    try {
        const response = await axios.get(`https://lrclib.net/api/search`, {
            params: { track_name: title, artist_name: artist },
            timeout: 5000
        });
        if (response.data && response.data.length > 0) {
            const match = response.data[0];
            return match.syncedLyrics || match.plainLyrics || null;
        }
    } catch (e) {
        console.log(`Lyrics no encontradas para ${title}`);
    }
    return null;
}

// Buscar Carátulas HD y Fotos de Artista en iTunes
async function searchArtworkAndPhoto(title, artist) {
    try {
        const res = await axios.get(`https://itunes.apple.com/search`, {
            params: { term: `${artist} ${title}`, entity: 'song', limit: 1 },
            timeout: 5000
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
        console.log(`Cover iTunes no encontrado para ${title}`);
    }
    return { cover_url: null, artist_photo: null };
}

// Escaneo de canciones
async function scrapeArtistMusic(artist) {
    console.log(`🔍 Escaneando música para: ${artist}`);
    try {
        const r = await ytSearch(`${artist} official audio track`);
        const videos = r.videos || [];

        for (const video of videos.slice(0, 5)) {
            const durationSeconds = video.duration.seconds;

            // Filtro estricto: Descartar audios menores a 60 segundos
            if (durationSeconds < 60) {
                console.log(`⏩ Omitida (< 60s): ${video.title}`);
                continue;
            }

            const { data: existing } = await supabase
                .from('songs')
                .select('id')
                .eq('title', video.title)
                .maybeSingle();

            if (existing) {
                console.log(`✔ Ya existe: ${video.title}`);
                continue;
            }

            const artwork = await searchArtworkAndPhoto(video.title, artist);
            const lyrics = await searchLyrics(video.title, artist);

            const songData = {
                title: video.title.replace(/\(Official Audio\)/i, '').replace(/[Official Audio]/i, '').trim(),
                artist: artist,
                duration: durationSeconds,
                source: 'youtube',
                audio_url: video.url,
                cover_url: artwork.cover_url || video.thumbnail,
                animated_cover: null,
                lyrics: lyrics || "[00:00.00] Letra no disponible en sincronía",
                artist_photo: artwork.artist_photo || video.thumbnail
            };

            const { error } = await supabase.from('songs').insert([songData]);
            if (error) console.error(`❌ Error guardando ${video.title}:`, error.message);
            else console.log(`✅ Guardada: ${songData.title}`);
        }
    } catch (e) {
        console.error(`Error en scraper de ${artist}:`, e.message);
    }
}

async function runScraperWorkflow() {
    console.log('🚀 Ejecutando workflow automático...');
    for (const artist of targetArtists) {
        await scrapeArtistMusic(artist);
    }
    console.log('🎉 Workflow finalizado.');
}

// Cron job cada 4 horas
cron.schedule('0 */4 * * *', () => {
    runScraperWorkflow();
});

// GET /api/songs (Soporta ?artist=... y ?search=...)
app.get('/api/songs', async (req, res) => {
    try {
        let query = supabase.from('songs').select('*').order('id', { ascending: false });
        if (req.query.artist) {
            query = query.ilike('artist', `%${req.query.artist}%`);
        }
        if (req.query.search) {
            query = query.or(`title.ilike.%${req.query.search}%,artist.ilike.%${req.query.search}%`);
        }
        const { data, error } = await query;
        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/songs/:id
app.get('/api/songs/:id', async (req, res) => {
    try {
        const { data, error } = await supabase.from('songs').select('*').eq('id', req.params.id).single();
        if (error) return res.status(404).json({ error: 'Canción no encontrada' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/upload (Subida Manual)
app.post('/api/upload', async (req, res) => {
    try {
        const { title, artist, duration, audio_url, cover_url, animated_cover, lyrics, artist_photo } = req.body;
        
        if (!title || !artist) {
            return res.status(400).json({ error: "Título y artista son obligatorios." });
        }
        if (duration && parseInt(duration) < 60) {
            return res.status(400).json({ error: "La canción debe durar al menos 60 segundos." });
        }

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
        res.json({ success: true, message: "Canción subida manualmente con éxito", song: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Sekai Music Server corriendo en puerto ${PORT}`);
    runScraperWorkflow();
});

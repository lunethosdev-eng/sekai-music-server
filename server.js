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

// Lista de artistas solicitados
const targetArtists = [
    "Depresión Sonora", "Eve", "Laufey", "Grupo Frontera", "Al Hars", 
    "Kenshi Yonezu", "Arctic Monkeys", "Joji"
];

// Anti-sleep para Render (Ping cada 13 min)
setInterval(async () => {
    try {
        await axios.get(`${RENDER_URL}/api/health`);
        console.log('Ping interno ejecutado');
    } catch (error) {
        console.error('Error en ping interno:', error.message);
    }
}, 13 * 60 * 1000);

app.get('/api/health', (req, res) => res.status(200).send('OK'));

// Búsqueda de letras sincronizadas en LRCLIB
async function searchLyrics(title, artist) {
    try {
        const response = await axios.get(`https://lrclib.net/api/search`, {
            params: { track_name: title, artist_name: artist }
        });
        if (response.data && response.data.length > 0) {
            const bestMatch = response.data[0];
            return bestMatch.syncedLyrics || bestMatch.plainLyrics || null;
        }
    } catch (e) {
        console.log(`Letras no encontradas para: ${title}`);
    }
    return null;
}

// Búsqueda de Carátulas HD y Foto de Artista en iTunes API
async function searchArtworkAndPhoto(title, artist) {
    try {
        const res = await axios.get(`https://itunes.apple.com/search`, {
            params: { term: `${artist} ${title}`, entity: 'song', limit: 1 }
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
        console.log(`Carátula HD no encontrada para: ${title}`);
    }
    return { cover_url: null, artist_photo: null };
}

// Búsqueda y guardado por artista
async function scrapeArtistMusic(artist) {
    console.log(`🔍 Escaneando canciones para: ${artist}...`);
    try {
        const r = await ytSearch(`${artist} official audio track`);
        const videos = r.videos || [];

        for (const video of videos.slice(0, 5)) {
            const durationSeconds = video.duration.seconds;

            // FILTRO ESTRICTO: Descartar audios de menos de 60 segundos
            if (durationSeconds < 60) {
                console.log(`⏩ Descartada por corta (${durationSeconds}s): ${video.title}`);
                continue;
            }

            // Evitar duplicados
            const { data: existing } = await supabase
                .from('songs')
                .select('id')
                .eq('title', video.title)
                .maybeSingle();

            if (existing) {
                console.log(`✔ Ya existe en catálogo: ${video.title}`);
                continue;
            }

            // Obtener Carátula HD y Letras Sincronizadas
            const artworkData = await searchArtworkAndPhoto(video.title, artist);
            const lyrics = await searchLyrics(video.title, artist);

            const songData = {
                title: video.title.replace(/\(Official Audio\)/i, '').replace(/[Official Audio]/i, '').trim(),
                artist: artist,
                duration: durationSeconds,
                source: 'youtube',
                audio_url: video.url,
                cover_url: artworkData.cover_url || video.thumbnail,
                animated_cover: null,
                lyrics: lyrics || "[00:00.00] Letra no disponible en sincronía",
                artist_photo: artworkData.artist_photo || video.thumbnail
            };

            const { error } = await supabase.from('songs').insert([songData]);
            if (error) {
                console.error(`❌ Error guardando ${video.title}:`, error.message);
            } else {
                console.log(`✅ Agregada al catálogo: ${songData.title}`);
            }
        }
    } catch (e) {
        console.error(`Error procesando a ${artist}:`, e.message);
    }
}

// Flujo principal de escaneo
async function runScraperWorkflow() {
    console.log('🚀 Iniciando escaneo automático e ingesta de canciones...');
    for (const artist of targetArtists) {
        await scrapeArtistMusic(artist);
    }
    console.log('🎉 Escaneo completado exitosamente.');
}

// Cron Job: Cada 4 horas
cron.schedule('0 */4 * * *', () => {
    runScraperWorkflow();
});

// Endpoints API
app.get('/api/songs', async (req, res) => {
    const { data, error } = await supabase.from('songs').select('*').order('id', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/upload', async (req, res) => {
    const { duration } = req.body;
    if (duration < 60) {
        return res.status(400).json({ error: "La canción dura menos de 60 segundos" });
    }

    const { data, error } = await supabase.from('songs').insert([req.body]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: "Canción guardada con éxito" });
});

app.listen(PORT, () => {
    console.log(`Sekai Music Server corriendo en puerto ${PORT}`);
    // AL ARRANCAR EL SERVIDOR, INICIAR BÚSQUEDA DE INMEDIATO
    runScraperWorkflow();
});

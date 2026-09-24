require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const ytSearch = require('yt-search');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { PassThrough } = require('stream');
const crypto = require('crypto');

// Configuración del motor de streaming de audio
const play = require('play-dl');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || 'https://sekai-music-server.onrender.com';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'sekai_admin_master_key_2026';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Error Crítico: Faltan SUPABASE_URL y SUPABASE_KEY en las variables de entorno.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const catalogCache = new NodeCache({ stdTTL: 120 });
let soundcloudClientId = 'iZea6V13B2S91I1B1i0x90nI0N6N9p6a';
let isScraperRunning = false;
let scraperCancelRequested = false;

// Estado Global del Sistema (Mantenimiento y Anuncios controlados vía Discord)
const systemState = {
    maintenance: false,
    maintenanceMessage: 'El sistema se encuentra en mantenimiento programado. Por favor, reintente en unos minutos.',
    announcement: null,
    announcementTimestamp: null
};

// Contador de Peticiones Globales
let totalApiRequests = 0;
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        totalApiRequests++;
    }
    next();
});

// Middleware Global de Verificación de Mantenimiento
const checkMaintenance = (req, res, next) => {
    if (systemState.maintenance && !req.path.startsWith('/api/system/') && !req.path.startsWith('/api/health')) {
        return res.status(530).json({
            status: 'maintenance',
            message: systemState.maintenanceMessage,
            timestamp: new Date().toISOString()
        });
    }
    next();
};
app.use(checkMaintenance);

// User Agents para Rotación Anti-Bloqueos
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Inicialización de Cookies de Youtube en Play-DL
async function initPlayDl() {
    try {
        const youtubeCookie = process.env.YOUTUBE_COOKIE;
        if (youtubeCookie) {
            await play.setToken({
                youtube: {
                    cookie: youtubeCookie
                }
            });
            console.log('🔑 Cookies de YouTube configuradas correctamente.');
        } else {
            console.warn('⚠️ Advertencia: No se encontró YOUTUBE_COOKIE en .env.');
        }
    } catch (err) {
        console.error('❌ Error configurando cookies en play-dl:', err.message);
    }
}

// Control de Concurrencia de Streams
const streamConcurrency = {
    current: 0,
    max: Number(process.env.MAX_STREAMS || 8),
};

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Generador de Claves API Únicas por Usuario
function generateUniqueApiKey() {
    return 'sk_live_' + crypto.randomBytes(24).toString('hex');
}

// Middleware de Autenticación de API Key Real (Validación en Supabase / Master Key)
const requireApiKey = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey) {
        return res.status(401).json({ status: 'error', message: 'API Key requerida en cabecera x-api-key o parámetro ?api_key=' });
    }

    if (apiKey === ADMIN_API_KEY) {
        req.user = { email: 'admin@sekai.internal', role: 'admin' };
        return next();
    }

    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('api_key', apiKey)
            .maybeSingle();

        if (error || !data) {
            return res.status(403).json({ status: 'error', message: 'API Key inválida o no registrada.' });
        }

        req.user = data;
        next();
    } catch (err) {
        return res.status(500).json({ status: 'error', message: 'Error al verificar la clave de API.' });
    }
};

function enrichSongV1(song) {
    if (!song || song.id == null) return song;
    return {
        ...song,
        stream_url: `${RENDER_URL}/api/v1/stream/${song.id}`,
    };
}

function enrichSongV2(song) {
    if (!song || song.id == null) return song;
    return {
        ...song,
        stream_url: `${RENDER_URL}/api/v2/stream/${song.id}`,
        high_res_cover: song.cover_url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=800&q=80',
        has_synced_lyrics: Boolean(song.lyrics && song.lyrics.startsWith('[')),
        api_version: 'v2'
    };
}

function enrichSongV3(song) {
    if (!song || song.id == null) return song;
    return {
        id: song.id,
        title: song.title,
        artist: song.artist,
        genre: song.genre,
        duration: song.duration,
        source: song.source,
        stream_url: `${RENDER_URL}/api/v3/stream/${song.id}?codec=ogg&bitrate=128k`,
        cover_url: song.cover_url,
        lyrics: song.lyrics,
        api_version: 'v3'
    };
}

function cleanTitleString(title) {
    if (!title) return '';
    return title
        .replace(/\[.*?\\]|\(.*?\)/g, '')
        .replace(/Official Video|Official Audio|Video Oficial|Lyric Video|Audio|4K|HD|Remastered|MV|PV|Full Song/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Scraper de Letras Sincronizadas
async function fetchSyncedLyrics(title, artist) {
    try {
        const cleanTitle = cleanTitleString(title);
        const res = await axios.get('https://lrclib.net/api/get', {
            params: { track_name: cleanTitle, artist_name: artist },
            timeout: 4000,
            headers: { 'User-Agent': 'SekaiMusicEngine/3.0' }
        });

        if (res.data) {
            if (res.data.syncedLyrics) return res.data.syncedLyrics;
            if (res.data.plainLyrics) return res.data.plainLyrics;
        }
    } catch (_) {
        try {
            const searchRes = await axios.get('https://lrclib.net/api/search', {
                params: { q: `${artist} ${title}` },
                timeout: 4000,
                headers: { 'User-Agent': 'SekaiMusicEngine/3.0' }
            });

            if (searchRes.data && searchRes.data.length > 0) {
                const match = searchRes.data[0];
                return match.syncedLyrics || match.plainLyrics || null;
            }
        } catch (_) {}
    }
    return '[00:00.00] Letra no disponible en la base de datos central.';
}

// Spotify Scraper Metadatos
async function getSpotifyToken() {
    try {
        const res = await axios.get('https://open.spotify.com/get_access_token', {
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 5000
        });
        return res.data?.accessToken || null;
    } catch (e) {
        console.error('❌ Error obteniendo token de Spotify:', e.message);
        return null;
    }
}

async function scrapeSpotifyPlaylist(playlistId) {
    try {
        const cleanId = playlistId.replace(/.*playlist[\/:]([a-zA-Z0-9]+).*/, '$1');
        const token = await getSpotifyToken();
        if (!token) return [];

        const res = await axios.get(`https://api.spotify.com/v1/playlists/${cleanId}/tracks?limit=100`, {
            headers: { 
                'Authorization': `Bearer ${token}`,
                'User-Agent': getRandomUserAgent()
            },
            timeout: 8000
        });

        if (!res.data || !res.data.items) return [];

        return res.data.items
            .filter(item => item.track)
            .map(item => ({
                title: item.track.name,
                artist: item.track.artists ? item.track.artists.map(a => a.name).join(', ') : 'Desconocido',
                album: item.track.album ? item.track.album.name : '',
                cover_url: item.track.album?.images[0]?.url || null,
                searchQuery: `${item.track.name} ${item.track.artists[0]?.name || ''}`
            }));
    } catch (e) {
        console.error('❌ Error en Scraper de Spotify:', e.message);
        return [];
    }
}

// SoundCloud & YouTube Scrapers
async function getSoundCloudClientId() {
    try {
        const pageRes = await axios.get('https://soundcloud.com', {
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 5000,
        });
        const jsUrls = pageRes.data.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9-]+\.js/g) || [];
        for (const url of jsUrls.slice(-4)) {
            try {
                const jsRes = await axios.get(url, { timeout: 5000 });
                const match = jsRes.data.match(/client_id\s*:\s*["']([a-zA-Z0-9]{32})["']/);
                if (match && match[1]) {
                    soundcloudClientId = match[1];
                    return soundcloudClientId;
                }
            } catch (_) {}
        }
    } catch (_) {}
    return soundcloudClientId;
}

async function searchSoundCloud(query) {
    try {
        const clientId = await getSoundCloudClientId();
        const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=50`;
        const res = await axios.get(url, {
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 6000,
        });

        if (res.data && res.data.collection) {
            return res.data.collection
                .map((t) => ({
                    title: t.title,
                    artist: t.user ? t.user.username : 'SoundCloud Artist',
                    duration: Math.floor((t.duration || 180000) / 1000),
                    source: 'soundcloud',
                    audio_url: t.permalink_url,
                    cover_url: t.artwork_url
                        ? t.artwork_url.replace('-large', '-t500x500')
                        : t.user ? t.user.avatar_url : null,
                }))
                .filter((t) => t.duration >= 45 && t.audio_url);
        }
    } catch (_) {}
    return [];
}

async function searchYouTube(query) {
    try {
        const r = await ytSearch(query);
        const videos = r.videos || [];
        return videos
            .map((v) => ({
                title: v.title,
                artist: v.author ? v.author.name.replace('VEVO', '').replace('- Topic', '').trim() : 'YouTube Artist',
                duration: v.duration.seconds,
                source: 'youtube',
                audio_url: v.url,
                cover_url: v.thumbnail,
            }))
            .filter((v) => v.duration >= 45 && v.audio_url);
    } catch (_) {}
    return [];
}

const searchTargets = [
    { genre: 'Eve', query: 'Eve ooo0eve0ooo Kaikai Kitan official' },
    { genre: 'Trío Los Panchos', query: 'Trio Los Panchos Sabor a mi clasicos' },
    { genre: 'Cuarteto de Nos', query: 'Cuarteto de Nos Porfiado Raro' },
    { genre: 'City Pop', query: '80s Japanese City Pop hits Tatsuro Yamashita' },
    { genre: 'Post-Punk', query: 'Molchat Doma Ploho Human Tetris Russian Post-Punk' },
    { genre: 'Boleros', query: 'Boleros del recuerdo clasicos inolvidables' },
    { genre: 'Indie Rock', query: 'Arctic Monkeys The Strokes Franz Ferdinand' },
    { genre: 'Lofi Beats', query: 'Lofi hip hop relaxing beats study chill' },
    { genre: 'Anime OST', query: 'Anime openings full official full soundtrack' },
    { genre: 'J-Pop', query: 'J-Pop top chart hits Yoasobi Ado Kenshi Yonezu' },
    { genre: 'Phonk', query: 'Drift phonk aggressive house Kordhell' },
    { genre: 'Vocaloid', query: 'Hatsune Miku Vocaloid original songs' },
    { genre: 'Rock en Español', query: 'Soda Stereo Enanitos Verdes Heroes del Silencio' },
];

async function sendDiscordSummary(addedSongs) {
    try {
        const channelId = process.env.DISCORD_CHANNEL_ID;
        if (!channelId) return;
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) return;

        const mainEmbed = new EmbedBuilder()
            .setTitle('🌙 Escaneo e Ingesta Finalizados')
            .setDescription(`Se han procesado e insertado exitosamente **${addedSongs.length} nuevas canciones** en la base de datos.`)
            .setColor(0x7289da)
            .setTimestamp();

        await channel.send({ embeds: [mainEmbed] });
    } catch (e) {
        console.error('Error enviando reporte a Discord:', e.message);
    }
}

async function runSlowScraper(maxSongsTarget = 1000, customCategory = null) {
    if (isScraperRunning) return;
    isScraperRunning = true;
    scraperCancelRequested = false;
    console.log(`🚀 [SCRAPER] Iniciando proceso (Objetivo: ~${maxSongsTarget} canciones)...`);

    const addedSongs = [];
    const targets = customCategory
        ? [{ genre: customCategory, query: customCategory }]
        : searchTargets;

    try {
        for (const target of targets) {
            if (scraperCancelRequested) break;
            if (addedSongs.length >= maxSongsTarget) break;

            const scTracks = await searchSoundCloud(target.query);
            await delay(1200);
            if (scraperCancelRequested) break;

            const ytTracks = await searchYouTube(target.query);
            await delay(1200);
            if (scraperCancelRequested) break;

            const allTracks = [...scTracks, ...ytTracks];
            const batchToInsert = [];

            for (const track of allTracks) {
                if (scraperCancelRequested) break;

                const cleanTitle = cleanTitleString(track.title);
                const artistName = track.artist || target.genre;
                const lyricsData = await fetchSyncedLyrics(cleanTitle, artistName);

                batchToInsert.push({
                    title: cleanTitle || track.title,
                    artist: artistName,
                    genre: target.genre,
                    duration: track.duration,
                    source: track.source,
                    audio_url: track.audio_url,
                    cover_url: track.cover_url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=500&q=80',
                    lyrics: lyricsData,
                });

                await delay(200);
            }

            if (batchToInsert.length > 0) {
                const { data, error } = await supabase
                    .from('songs')
                    .upsert(batchToInsert, {
                        onConflict: 'audio_url',
                        ignoreDuplicates: true,
                    })
                    .select();

                if (!error && data) {
                    addedSongs.push(...data);
                }
            }

            await delay(2000);
        }

        catalogCache.del('full_catalog');
        if (addedSongs.length > 0) {
            await sendDiscordSummary(addedSongs);
        }
    } catch (e) {
        console.error('Error general en scraper:', e.message);
    } finally {
        isScraperRunning = false;
        scraperCancelRequested = false;
    }
}

cron.schedule('0 21,22,23,0,1,2,3,4,5,6 * * *', () => {
    runSlowScraper(500);
});

// Bot de Discord & Comandos de Administración en Tiempo Real
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    try {
        if (command === 'announcement' || command === 'anuncio') {
            const announcementMsg = args.join(' ');
            if (!announcementMsg) {
                systemState.announcement = null;
                systemState.announcementTimestamp = null;
                return message.reply('📢 Anuncio global limpiado.');
            }

            systemState.announcement = announcementMsg;
            systemState.announcementTimestamp = new Date().toISOString();
            return message.reply(`📢 **Anuncio Global Publicado en el sitio web:**\n> "${announcementMsg}"`);
        }

        if (command === 'mantenimiento') {
            const subCommand = args[0] ? args[0].toLowerCase() : '';
            if (subCommand === 'off' || subCommand === 'desactivar') {
                systemState.maintenance = false;
                return message.reply('🟢 **Modo Mantenimiento DESACTIVADO.** El sitio web y la API están operativos.');
            }

            const maintenanceMsg = args.join(' ');
            systemState.maintenance = true;
            if (maintenanceMsg) {
                systemState.maintenanceMessage = maintenanceMsg;
            }

            return message.reply(`🛠️ **Modo Mantenimiento ACTIVADO.**\nMensaje mostrado a usuarios: "${systemState.maintenanceMessage}"`);
        }

        if (command === 'status') {
            return message.reply(
                `📊 **Estado del Sistema:**\n` +
                `- Mantenimiento: ${systemState.maintenance ? '🔴 ACTIVADO' : '🟢 DESACTIVADO'}\n` +
                `- Anuncio Activo: ${systemState.announcement ? `"${systemState.announcement}"` : 'Ninguno'}\n` +
                `- Scraper: ${isScraperRunning ? '🔄 En ejecución' : '⏸️ En espera'}\n` +
                `- Streams Concurrente: ${streamConcurrency.current}/${streamConcurrency.max}`
            );
        }

        if (command === 'help' || command === 'comandos') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('🤖 Control Total de Sekai Music Enterprise')
                .setColor(0x3498db)
                .addFields(
                    { name: '!anuncio [mensaje]', value: 'Publica un anuncio global inmediato en la web' },
                    { name: '!mantenimiento [mensaje]', value: 'Bloquea el sitio y activa pantalla de mantenimiento' },
                    { name: '!mantenimiento off', value: 'Restaura el sitio web y la API' },
                    { name: '!status', value: 'Estado completo del servidor, scraper y mantenimiento' },
                    { name: '!stats', value: 'Cantidad de canciones en Supabase' },
                    { name: '!trigger', value: 'Inicia el scraper de canciones manualmente' },
                    { name: '!stop', value: 'Detiene el scraper en ejecución' }
                );
            return message.reply({ embeds: [helpEmbed] });
        }

        if (command === 'stats') {
            const { count, error } = await supabase.from('songs').select('*', { count: 'exact', head: true });
            if (error) return message.reply('❌ Error al obtener estadísticas.');
            return message.reply(`📊 Total en la base de datos: **${count} canciones**.`);
        }

        if (command === 'trigger') {
            if (isScraperRunning) return message.reply('⚠️ El scraper ya se encuentra ejecutándose.');
            message.reply('🚀 Forzando inicio del scraper...');
            runSlowScraper(300);
            return;
        }

        if (command === 'stop') {
            if (!isScraperRunning) return message.reply('🟢 No hay scraper activo.');
            scraperCancelRequested = true;
            return message.reply('🛑 Cancelación solicitada.');
        }
    } catch (err) {
        console.error('Discord Command Error:', err.message);
    }
});

// Motor de Audio Streaming
async function getAudioStream(audioUrl) {
    if (!audioUrl || typeof audioUrl !== 'string') throw new Error('audio_url inválido');
    const url = audioUrl.trim();
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    const isSoundCloud = url.includes('soundcloud.com');

    if (!isYouTube && !isSoundCloud) {
        if (url.startsWith('http')) {
            const response = await axios.get(url, {
                responseType: 'stream',
                timeout: 30000,
                headers: { 'User-Agent': getRandomUserAgent() },
            });
            return response.data;
        }
        throw new Error(`Fuente no soportada: ${url}`);
    }

    const result = await play.stream(url, { quality: 2, discordPlayerCompatibility: false });
    if (!result || !result.stream) throw new Error('No se pudo obtener el stream de audio.');
    return result.stream;
}

function convertStreamToOgg(inputStream) {
    const outputStream = new PassThrough();
    const command = ffmpeg(inputStream)
        .noVideo()
        .audioCodec('libvorbis')
        .audioBitrate('128k')
        .format('ogg')
        .on('error', (error) => {
            console.error('❌ FFmpeg error:', error.message);
            outputStream.destroy(error);
        });
    inputStream.on('error', (error) => outputStream.destroy(error));
    command.pipe(outputStream, { end: true });
    return outputStream;
}

// REST ENDPOINTS

// Endpoint de Estado del Sistema y Mantenimiento/Anuncios
app.get('/api/system/status', (req, res) => {
    res.json({
        status: 'ok',
        maintenance: systemState.maintenance,
        maintenanceMessage: systemState.maintenanceMessage,
        announcement: systemState.announcement,
        announcementTimestamp: systemState.announcementTimestamp,
        serverTime: new Date().toISOString()
    });
});

// Registro Auténtico de Usuarios y Generación de API Keys Únicas
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ status: 'error', message: 'Email y contraseña requeridos.' });
        }

        const { data: existingUser } = await supabase
            .from('users')
            .select('email')
            .eq('email', email)
            .maybeSingle();

        if (existingUser) {
            return res.status(400).json({ status: 'error', message: 'El correo electrónico ya está registrado.' });
        }

        const newApiKey = generateUniqueApiKey();
        const { data, error } = await supabase
            .from('users')
            .insert([{ email, password_hash: password, api_key: newApiKey }])
            .select()
            .single();

        if (error) {
            return res.status(500).json({ status: 'error', message: error.message });
        }

        res.json({
            status: 'success',
            user: { email: data.email, apiKey: data.api_key }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Login Auténtico
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .eq('password_hash', password)
            .maybeSingle();

        if (error || !user) {
            return res.status(401).json({ status: 'error', message: 'Credenciales inválidas.' });
        }

        res.json({
            status: 'success',
            user: { email: user.email, apiKey: user.api_key }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Health Metric
app.get('/api/health', async (req, res) => {
    let dbOk = false;
    let songCount = 0;
    try {
        const { count, error } = await supabase.from('songs').select('id', { head: true, count: 'exact' });
        dbOk = !error;
        songCount = count || 0;
    } catch (_) {}

    res.status(200).json({
        status: 'ok',
        server: RENDER_URL,
        maintenance: systemState.maintenance,
        announcement: systemState.announcement,
        scraper_running: isScraperRunning,
        streams: streamConcurrency.current,
        max_streams: streamConcurrency.max,
        total_songs: songCount,
        total_api_requests: totalApiRequests,
        db: dbOk ? 'up' : 'down',
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        uptime_sec: Math.floor(process.uptime()),
    });
});

// ==========================================
// API VERSION 1 (v1) - Catálogo Clásico
// ==========================================
app.get('/api/v1/catalog', async (req, res) => {
    try {
        const { data, error } = await supabase.from('songs').select('*').order('id', { ascending: false }).limit(200);
        if (error) return res.status(500).json({ status: 'error', message: error.message });
        res.json({ status: 'success', version: 'v1', total: data.length, catalog: data.map(enrichSongV1) });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/v1/stream/:id', async (req, res) => {
    handleStreamRequest(req, res);
});

// ==========================================
// API VERSION 2 (v2) - Metadatos HD & LRC
// ==========================================
app.get('/api/v2/catalog', async (req, res) => {
    try {
        const { data, error } = await supabase.from('songs').select('*').order('id', { ascending: false }).limit(500);
        if (error) return res.status(500).json({ status: 'error', message: error.message });
        res.json({ status: 'success', version: 'v2', total: data.length, catalog: data.map(enrichSongV2) });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/v2/stream/:id', async (req, res) => {
    handleStreamRequest(req, res);
});

// ==========================================
// API VERSION 3 (v3) - Optimized Stream Pipeline
// ==========================================
app.get('/api/v3/catalog', async (req, res) => {
    try {
        const { data, error } = await supabase.from('songs').select('*').order('id', { ascending: false }).limit(1000);
        if (error) return res.status(500).json({ status: 'error', message: error.message });
        res.json({ status: 'success', version: 'v3', total: data.length, catalog: data.map(enrichSongV3) });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/v3/stream/:id', async (req, res) => {
    handleStreamRequest(req, res);
});

// ==========================================
// API VERSION 4 (v4) - Analytics & Trends
// ==========================================
app.get('/api/v4/trends', async (req, res) => {
    try {
        const { data, error } = await supabase.from('songs').select('genre, id').limit(1000);
        if (error) return res.status(500).json({ status: 'error', message: error.message });

        const genreCounts = {};
        data.forEach(item => {
            const g = item.genre || 'Desconocido';
            genreCounts[g] = (genreCounts[g] || 0) + 1;
        });

        res.json({
            status: 'success',
            version: 'v4',
            total_analyzed: data.length,
            genres_distribution: genreCounts,
            active_streams: streamConcurrency.current,
            system_load: `${Math.round((streamConcurrency.current / streamConcurrency.max) * 100)}%`
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// API VERSION 5 (v5) - Batch High-Performance Payload
// ==========================================
app.post('/api/v5/batch-query', requireApiKey, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids)) {
            return res.status(400).json({ status: 'error', message: 'Se requiere un arreglo "ids"' });
        }

        const { data, error } = await supabase.from('songs').select('*').in('id', ids.slice(0, 100));
        if (error) return res.status(500).json({ status: 'error', message: error.message });

        res.json({
            status: 'success',
            version: 'v5',
            count: data.length,
            results: data.map(enrichSongV2)
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Buscador Global
app.get('/api/v1/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ status: 'error', message: 'Falta parámetro ?q=' });

        const { data, error } = await supabase
            .from('songs')
            .select('*')
            .or(`title.ilike.%${q}%,artist.ilike.%${q}%,genre.ilike.%${q}%`)
            .limit(100);

        if (error) return res.status(500).json({ status: 'error', message: error.message });

        res.json({
            status: 'success',
            total: data.length,
            results: data.map(enrichSongV1),
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Función Manejadora Unificada de Audio Streaming
async function handleStreamRequest(req, res) {
    try {
        if (streamConcurrency.current >= streamConcurrency.max) {
            return res.status(429).json({ status: 'error', message: 'Límite de streams alcanzado. Reintente en unos segundos.' });
        }
        streamConcurrency.current += 1;

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            streamConcurrency.current = Math.max(0, streamConcurrency.current - 1);
            return res.status(400).json({ status: 'error', message: 'ID de canción inválido' });
        }

        const { data: song, error } = await supabase
            .from('songs')
            .select('id, title, audio_url, source')
            .eq('id', id)
            .maybeSingle();

        if (error || !song || !song.audio_url) {
            streamConcurrency.current = Math.max(0, streamConcurrency.current - 1);
            return res.status(error ? 500 : 404).json({
                status: 'error',
                message: error ? error.message : 'Canción no encontrada',
            });
        }

        console.log(`🎧 Streaming Track #${id}: ${song.title}`);
        const sourceStream = await getAudioStream(song.audio_url);

        res.status(200);
        res.setHeader('Content-Type', 'audio/ogg');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `inline; filename="sekai_${id}.ogg"`);

        const oggStream = convertStreamToOgg(sourceStream);

        const cleanup = () => {
            streamConcurrency.current = Math.max(0, streamConcurrency.current - 1);
            try { sourceStream.destroy?.(); } catch (_) {}
            try { oggStream.destroy?.(); } catch (_) {}
        };

        oggStream.on('error', (err) => {
            console.error('Stream Error:', err.message);
            cleanup();
            if (!res.headersSent) res.status(500).end();
            else if (!res.destroyed) res.destroy(err);
        });

        req.on('close', cleanup);
        res.on('close', cleanup);
        oggStream.pipe(res);
    } catch (err) {
        streamConcurrency.current = Math.max(0, streamConcurrency.current - 1);
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    }
}

// Inserción Manual
app.post('/api/upload', requireApiKey, async (req, res) => {
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
            lyrics: lyrics || null,
        };
        const { data, error } = await supabase.from('songs').insert([songData]).select();
        if (error) return res.status(500).json({ error: error.message });

        catalogCache.del('full_catalog');
        res.json({ success: true, song: enrichSongV1(data[0]) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Inicialización de Servidores
app.listen(PORT, async () => {
    console.log(`🚀 Servidor Enterprise activo en el puerto ${PORT}`);
    await initPlayDl();

    if (process.env.DISCORD_BOT_TOKEN) {
        try {
            await discordClient.login(process.env.DISCORD_BOT_TOKEN);
            console.log('🤖 Bot de Discord de Administración Conectado Exitosamente');
        } catch (error) {
            console.error('❌ Error al conectar Bot de Discord:', error.message);
        }
    }
});

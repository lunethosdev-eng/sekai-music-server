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

// Audio stream (YouTube / SoundCloud → OGG para la app)
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
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'sekai_secret_key_123';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Faltan SUPABASE_URL y SUPABASE_KEY en las variables de entorno.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const catalogCache = new NodeCache({ stdTTL: 120 });
let soundcloudClientId = 'iZea6V13B2S91I1B1i0x90nI0N6N9p6a';
let isScraperRunning = false;
let scraperCancelRequested = false;

// Contador de peticiones global
let totalApiRequests = 0;
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        totalApiRequests++;
    }
    next();
});

// User Agents para rotación anti-bloqueo
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Configuración de cookies en play-dl
async function initPlayDl() {
    try {
        const youtubeCookie = process.env.YOUTUBE_COOKIE;
        if (youtubeCookie) {
            await play.setToken({
                youtube: {
                    cookie: youtubeCookie
                }
            });
            console.log('🔑 Cookies de YouTube cargadas correctamente en play-dl.');
        } else {
            console.warn('⚠️ No se encontró YOUTUBE_COOKIE en .env. YouTube podría limitar o bloquear peticiones.');
        }
    } catch (err) {
        console.error('❌ Error configurando cookies en play-dl:', err.message);
    }
}

// Límite de streams simultáneos
const streamConcurrency = {
    current: 0,
    max: Number(process.env.MAX_STREAMS || 4),
};

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requireAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === ADMIN_API_KEY) return next();
    return res.status(401).json({ status: 'error', message: 'No autorizado.' });
};

function enrichSong(song) {
    if (!song || song.id == null) return song;
    return {
        ...song,
        stream_url: `${RENDER_URL}/api/v1/stream/${song.id}`,
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

// ============================================================
// 1. SCRAPER DE LETRAS (LRCLIB API)
// ============================================================
async function fetchSyncedLyrics(title, artist) {
    try {
        const cleanTitle = cleanTitleString(title);
        const res = await axios.get('https://lrclib.net/api/get', {
            params: { track_name: cleanTitle, artist_name: artist },
            timeout: 4000,
            headers: { 'User-Agent': 'SekaiMusic/2.0' }
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
                headers: { 'User-Agent': 'SekaiMusic/2.0' }
            });

            if (searchRes.data && searchRes.data.length > 0) {
                const match = searchRes.data[0];
                return match.syncedLyrics || match.plainLyrics || null;
            }
        } catch (_) {}
    }
    return '[00:00.00] Letra no disponible';
}

// ============================================================
// 2. SCRAPER DE SPOTIFY (METADATOS DE PLAYLISTS / CHARTS)
// ============================================================
async function getSpotifyToken() {
    try {
        const res = await axios.get('https://open.spotify.com/get_access_token', {
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 5000
        });
        return res.data?.accessToken || null;
    } catch (e) {
        console.error('❌ Error obteniendo token público de Spotify:', e.message);
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

// ============================================================
// 3. SOUNDCLOUD / YOUTUBE SCRAPERS
// ============================================================
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
            .setDescription(`Se han procesado e insertado exitosamente **${addedSongs.length} nuevas canciones** con letras sincronizadas.`)
            .setColor(0x7289da)
            .setTimestamp();

        await channel.send({ embeds: [mainEmbed] });

        for (const song of addedSongs.slice(0, 5)) {
            const songEmbed = new EmbedBuilder()
                .setTitle(song.title)
                .addFields(
                    { name: 'Artista', value: song.artist || '?', inline: true },
                    { name: 'Género', value: song.genre || '?', inline: true },
                    { name: 'Fuente', value: song.source || '?', inline: true }
                )
                .setThumbnail(song.cover_url)
                .setColor(0x2ecc71);

            await channel.send({ embeds: [songEmbed] });
            await delay(300);
        }

        if (addedSongs.length > 5) {
            await channel.send(`*...y ${addedSongs.length - 5} canciones más registradas.*`);
        }
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
            if (scraperCancelRequested) {
                console.log('🛑 Scraper cancelado por el usuario.');
                break;
            }
            if (addedSongs.length >= maxSongsTarget) break;

            console.log(`⏳ Buscando: [${target.genre}] -> "${target.query}"`);

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
                    console.log(`✅ +${data.length} agregadas de [${target.genre}]. Total sesión: ${addedSongs.length}`);
                }
            }

            await delay(2000);
        }

        catalogCache.del('full_catalog');
        console.log(`🎉 [SCRAPER] Finalizado. Total agregadas: ${addedSongs.length}`);

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

async function runSpotifyImport(playlistUrl, limit = 50) {
    if (isScraperRunning) return 0;
    isScraperRunning = true;
    console.log(`🟢 Importando desde Spotify Playlist: ${playlistUrl}`);

    const addedSongs = [];

    try {
        const tracks = await scrapeSpotifyPlaylist(playlistUrl);
        console.log(`🎵 Se encontraron ${tracks.length} canciones en Spotify. Buscando audios...`);

        for (const track of tracks.slice(0, limit)) {
            if (scraperCancelRequested) break;

            const ytResults = await searchYouTube(track.searchQuery);
            if (ytResults && ytResults.length > 0) {
                const bestMatch = ytResults[0];
                const lyrics = await fetchSyncedLyrics(track.title, track.artist);

                const songObj = {
                    title: track.title,
                    artist: track.artist,
                    genre: 'Spotify Import',
                    duration: bestMatch.duration,
                    source: 'youtube',
                    audio_url: bestMatch.audio_url,
                    cover_url: track.cover_url || bestMatch.cover_url,
                    lyrics: lyrics
                };

                const { data, error } = await supabase
                    .from('songs')
                    .upsert([songObj], { onConflict: 'audio_url', ignoreDuplicates: true })
                    .select();

                if (!error && data && data.length > 0) {
                    addedSongs.push(data[0]);
                    console.log(`✅ Importada: ${track.artist} - ${track.title}`);
                }
            }
            await delay(1500);
        }

        catalogCache.del('full_catalog');
        if (addedSongs.length > 0) await sendDiscordSummary(addedSongs);
    } catch (e) {
        console.error('Error importando desde Spotify:', e.message);
    } finally {
        isScraperRunning = false;
        scraperCancelRequested = false;
    }

    return addedSongs.length;
}

cron.schedule('0 21,22,23,0,1,2,3,4,5,6 * * *', () => {
    console.log('⏰ Horario nocturno activado (9 PM - 6 AM). Iniciando ciclo de ingesta...');
    runSlowScraper(500);
});

// ============================================================
// 4. BOT DE DISCORD
// ============================================================
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    try {
        if (command === 'status') {
            return message.reply(
                isScraperRunning
                    ? `🔄 Scraper **activo** · Streams en uso: ${streamConcurrency.current}/${streamConcurrency.max}`
                    : `🟢 Scraper en espera · Streams en uso: ${streamConcurrency.current}/${streamConcurrency.max}`
            );
        }

        if (command === 'help' || command === 'comandos') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('🤖 Comandos de Sekai Music Bot')
                .setColor(0x3498db)
                .addFields(
                    { name: '!status', value: 'Estado del scraper y streams' },
                    { name: '!stats', value: 'Total de canciones en la BD' },
                    { name: '!add [cant] [género]', value: 'Ej: `!add 50 vocaloid`' },
                    { name: '!spotify [link_playlist]', value: 'Importa canciones desde una playlist de Spotify' },
                    { name: '!lyrics [id_cancion]', value: 'Busca y actualiza la letra sincronizada por ID' },
                    { name: '!search [nombre]', value: 'Busca canciones en el catálogo' },
                    { name: '!song [id]', value: 'Muestra detalle + link de streaming de la canción' },
                    { name: '!trigger', value: 'Fuerza el scraper nocturno estándar (300 canciones)' },
                    { name: '!stop', value: 'Cancela la ejecución del scraper activo' },
                    { name: '!cache', value: 'Limpia la caché del catálogo en memoria' }
                );
            return message.reply({ embeds: [helpEmbed] });
        }

        if (command === 'stats') {
            const { count, error } = await supabase
                .from('songs')
                .select('*', { count: 'exact', head: true });
            if (error) return message.reply('❌ Error al obtener estadísticas.');
            return message.reply(`📊 Total en la base de datos: **${count} canciones**.`);
        }

        if (command === 'spotify') {
            const playlistUrl = args[0];
            if (!playlistUrl) return message.reply('❌ Uso: `!spotify https://open.spotify.com/playlist/...`');

            if (isScraperRunning) return message.reply('⚠️ El scraper ya está ocupado.');

            message.reply('🟢 Iniciando extracción de metadatos desde Spotify...');
            runSpotifyImport(playlistUrl, 50);
            return;
        }

        if (command === 'lyrics') {
            const id = Number(args[0]);
            if (!id) return message.reply('❌ Indica el ID de la canción. Ej: `!lyrics 102`');

            const { data: song } = await supabase.from('songs').select('*').eq('id', id).maybeSingle();
            if (!song) return message.reply('❌ Canción no encontrada.');

            const fetchedLyrics = await fetchSyncedLyrics(song.title, song.artist);
            await supabase.from('songs').update({ lyrics: fetchedLyrics }).eq('id', id);

            return message.reply(`✅ Letra actualizada para **${song.title}**.`);
        }

        if (command === 'search') {
            const query = args.join(' ');
            if (!query) return message.reply('❌ Indica qué buscar. Ej: `!search Eve`');

            const { data } = await supabase
                .from('songs')
                .select('id, title, artist, source')
                .or(`title.ilike.%${query}%,artist.ilike.%${query}%`)
                .limit(8);

            if (!data || data.length === 0) return message.reply('🔍 No se encontraron coincidencias.');

            const results = data.map((s, i) => `${i + 1}. \`#${s.id}\` **${s.title}** - ${s.artist} *(${s.source})*`).join('\n');
            return message.reply(`🎵 **Resultados:**\n${results}`);
        }

        if (command === 'song' || command === 'cancion') {
            const id = Number(args[0]);
            if (!Number.isInteger(id) || id <= 0) return message.reply('❌ Uso: `!song 15430`');

            const { data, error } = await supabase.from('songs').select('*').eq('id', id).maybeSingle();
            if (error || !data) return message.reply('❌ Canción no encontrada.');

            const streamUrl = `${RENDER_URL}/api/v1/stream/${data.id}`;
            const embed = new EmbedBuilder()
                .setTitle(data.title || 'Sin título')
                .setDescription(`**Artista:** ${data.artist || '?'}\n**Género:** ${data.genre || '?'}\n**Fuente:** ${data.source || '?'}\n**Duración:** ${data.duration || '?'}s\n**Stream:** ${streamUrl}`)
                .setColor(0x9b59b6);
            if (data.cover_url) embed.setThumbnail(data.cover_url);
            return message.reply({ embeds: [embed] });
        }

        if (command === 'trigger') {
            if (isScraperRunning) return message.reply('⚠️ El scraper ya se encuentra ejecutándose.');
            await message.reply('🚀 Forzando inicio del scraper...');
            runSlowScraper(300);
            return;
        }

        if (command === 'add') {
            const limit = parseInt(args[0], 10) || 50;
            const category = args.slice(1).join(' ') || null;

            if (isScraperRunning) return message.reply('⚠️ El scraper ya está ejecutando un proceso.');

            await message.reply(`🚀 Iniciando ingesta manual de hasta **${limit} canciones** ${category ? `para "${category}"` : ''}.`);
            runSlowScraper(limit, category);
            return;
        }

        if (command === 'stop') {
            if (!isScraperRunning) return message.reply('🟢 No hay scraper activo.');
            scraperCancelRequested = true;
            return message.reply('🛑 Cancelación solicitada. Se detendrá al terminar el lote actual.');
        }

        if (command === 'cache') {
            catalogCache.del('full_catalog');
            return message.reply('🧹 Caché del catálogo limpiada.');
        }
    } catch (err) {
        console.error('Discord Error:', err.message);
        return message.reply(`❌ ${err.message}`);
    }
});

// ============================================================
// 5. AUDIO: OBTENER STREAM Y TRANSCODIFICAR A OGG
// ============================================================
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

    console.log(`🎧 Obteniendo audio: ${url}`);
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

// ============================================================
// 6. ENDPOINTS API REST (EXPRESS)
// ============================================================
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

app.get('/api/v1/catalog', async (req, res) => {
    try {
        const cached = catalogCache.get('full_catalog');
        if (cached) return res.json(cached);

        const { count, error: countError } = await supabase.from('songs').select('*', { count: 'exact', head: true });
        if (countError) return res.status(500).json({ status: 'error', message: countError.message });

        let allSongs = [];
        let page = 0;
        const pageSize = 1000;
        let hasMore = true;

        while (hasMore) {
            const { data, error } = await supabase
                .from('songs')
                .select('*')
                .range(page * pageSize, (page + 1) * pageSize - 1)
                .order('id', { ascending: false });

            if (error) return res.status(500).json({ status: 'error', message: error.message });

            allSongs = allSongs.concat(data || []);
            if (!data || data.length < pageSize) hasMore = false;
            else page++;
        }

        const payload = {
            status: 'success',
            server: RENDER_URL,
            total: count,
            fetched: allSongs.length,
            catalog: allSongs.map(enrichSong),
        };
        catalogCache.set('full_catalog', payload);
        res.json(payload);
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

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
            results: data.map(enrichSong),
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/v1/song/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { data, error } = await supabase.from('songs').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ status: 'error', message: 'No encontrada' });

        res.json({ status: 'success', song: enrichSong(data) });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/v1/stream/:id', async (req, res) => {
    try {
        if (streamConcurrency.current >= streamConcurrency.max) {
            return res.status(429).json({ status: 'error', message: 'Demasiados streams a la vez. Reintenta en unos segundos.' });
        }
        streamConcurrency.current += 1;

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            streamConcurrency.current = Math.max(0, streamConcurrency.current - 1);
            return res.status(400).json({ status: 'error', message: 'ID inválido' });
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

        console.log(`🎧 Stream #${id}: ${song.title}`);
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
            console.error('Stream error:', err.message);
            cleanup();
            if (!res.headersSent) res.status(500).end();
            else if (!res.destroyed) res.destroy(err);
        });

        req.on('close', cleanup);
        res.on('close', cleanup);
        oggStream.pipe(res);
    } catch (err) {
        streamConcurrency.current = Math.max(0, streamConcurrency.current - 1);
        console.error('/stream:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    }
});

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
            lyrics: lyrics || null,
        };
        const { data, error } = await supabase.from('songs').insert([songData]).select();
        if (error) return res.status(500).json({ error: error.message });

        catalogCache.del('full_catalog');
        res.json({ success: true, song: enrichSong(data[0]) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// INICIALIZACIÓN DE SERVIDOR Y DISCORD
// ============================================================
app.listen(PORT, async () => {
    console.log(`🚀 Servidor activo en puerto ${PORT}`);
    console.log(`📡 Stream: ${RENDER_URL}/api/v1/stream/:id`);

    // Inicializar tokens y cookies de play-dl
    await initPlayDl();

    if (process.env.DISCORD_BOT_TOKEN) {
        try {
            await discordClient.login(process.env.DISCORD_BOT_TOKEN);
            console.log('🤖 Bot de Discord conectado exitosamente');
        } catch (error) {
            console.error('❌ Error al conectar el bot de Discord:', error.message);
        }
    }
});

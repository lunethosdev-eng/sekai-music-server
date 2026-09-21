require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const ytSearch = require('yt-search');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// AUDIO / FFMPEG
// ============================================================
const play = require('play-dl');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { PassThrough } = require('stream');

ffmpeg.setFfmpegPath(ffmpegPath);

// ============================================================
// EXPRESS
// ============================================================
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const RENDER_URL =
    process.env.RENDER_URL ||
    'https://sekai-music-server.onrender.com';

const ADMIN_API_KEY =
    process.env.ADMIN_API_KEY ||
    'sekai_secret_key_123';

// ============================================================
// SUPABASE
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Faltan SUPABASE_URL y SUPABASE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================
// VARIABLES
// ============================================================
const catalogCache = new NodeCache({ stdTTL: 120 });

let soundcloudClientId = 'iZea6V13B2S91I1B1i0x90nI0N6N9p6a';

let isScraperRunning = false;
let scraperCancelRequested = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// DISCORD
// ============================================================
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ============================================================
// AUTH
// ============================================================
const requireAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];

    if (apiKey && apiKey === ADMIN_API_KEY) {
        return next();
    }

    return res.status(401).json({
        status: 'error',
        message: 'No autorizado.',
    });
};

// ============================================================
// SOUNDCLOUD CLIENT ID
// ============================================================
async function getSoundCloudClientId() {
    try {
        const pageRes = await axios.get('https://soundcloud.com', {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            },
            timeout: 5000,
        });

        const jsUrls =
            pageRes.data.match(
                /https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9-]+\.js/g
            ) || [];

        for (const url of jsUrls.slice(-4)) {
            try {
                const jsRes = await axios.get(url, { timeout: 5000 });
                const match = jsRes.data.match(
                    /client_id\s*:\s*["']([a-zA-Z0-9]{32})["']/
                );

                if (match && match[1]) {
                    soundcloudClientId = match[1];
                    return soundcloudClientId;
                }
            } catch (_) {}
        }
    } catch (_) {}

    return soundcloudClientId;
}

// ============================================================
// SEARCH SOUNDCLOUD
// ============================================================
async function searchSoundCloud(query) {
    try {
        const clientId = await getSoundCloudClientId();
        const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(
            query
        )}&client_id=${clientId}&limit=50`;

        const res = await axios.get(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            },
            timeout: 6000,
        });

        if (res.data && res.data.collection) {
            return res.data.collection
                .map((t) => ({
                    title: t.title,
                    artist: t.user
                        ? t.user.username
                        : 'SoundCloud Artist',
                    duration: Math.floor((t.duration || 180000) / 1000),
                    source: 'soundcloud',
                    audio_url: t.permalink_url,
                    cover_url: t.artwork_url
                        ? t.artwork_url.replace('-large', '-t500x500')
                        : t.user
                          ? t.user.avatar_url
                          : null,
                }))
                .filter((t) => t.duration >= 45 && t.audio_url);
        }
    } catch (_) {}

    return [];
}

// ============================================================
// SEARCH YOUTUBE
// ============================================================
async function searchYouTube(query) {
    try {
        const r = await ytSearch(query);
        const videos = r.videos || [];

        return videos
            .map((v) => ({
                title: v.title,
                artist: v.author
                    ? v.author.name
                          .replace('VEVO', '')
                          .replace('- Topic', '')
                          .trim()
                    : 'YouTube Artist',
                duration: v.duration.seconds,
                source: 'youtube',
                audio_url: v.url,
                cover_url: v.thumbnail,
            }))
            .filter((v) => v.duration >= 45 && v.audio_url);
    } catch (_) {}

    return [];
}

// ============================================================
// SCRAPER TARGETS
// ============================================================
const searchTargets = [
    {
        genre: 'Eve',
        query: 'Eve ooo0eve0ooo Kaikai Kitan official',
    },
    {
        genre: 'Trío Los Panchos',
        query: 'Trio Los Panchos Sabor a mi clasicos',
    },
    {
        genre: 'Cuarteto de Nos',
        query: 'Cuarteto de Nos Porfiado Raro',
    },
    {
        genre: 'City Pop',
        query: '80s Japanese City Pop hits Tatsuro Yamashita',
    },
    {
        genre: 'Post-Punk',
        query: 'Molchat Doma Ploho Human Tetris Russian Post-Punk',
    },
    {
        genre: 'Boleros',
        query: 'Boleros del recuerdo clasicos inolvidables',
    },
    {
        genre: 'Indie Rock',
        query: 'Arctic Monkeys The Strokes Franz Ferdinand',
    },
    {
        genre: 'Lofi Beats',
        query: 'Lofi hip hop relaxing beats study chill',
    },
    {
        genre: 'Anime OST',
        query: 'Anime openings full official full soundtrack',
    },
    {
        genre: 'J-Pop',
        query: 'J-Pop top chart hits Yoasobi Ado Kenshi Yonezu',
    },
    {
        genre: 'Phonk',
        query: 'Drift phonk aggressive house Kordhell',
    },
    {
        genre: 'Vocaloid',
        query: 'Hatsune Miku Vocaloid original songs',
    },
    {
        genre: 'Rock en Español',
        query: 'Soda Stereo Enanitos Verdes Heroes del Silencio',
    },
];

// ============================================================
// DISCORD SUMMARY
// ============================================================
async function sendDiscordSummary(addedSongs) {
    try {
        const channelId = process.env.DISCORD_CHANNEL_ID;
        if (!channelId) return;

        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) return;

        const mainEmbed = new EmbedBuilder()
            .setTitle('🌙 Escaneo de Canciones Finalizado')
            .setDescription(
                `Se han procesado e insertado exitosamente **${addedSongs.length} nuevas canciones** sin duplicados.`
            )
            .setColor(0x7289da)
            .setTimestamp();

        await channel.send({ embeds: [mainEmbed] });

        const sampleSongs = addedSongs.slice(0, 5);

        for (const song of sampleSongs) {
            const songEmbed = new EmbedBuilder()
                .setTitle(song.title)
                .addFields(
                    {
                        name: 'Artista',
                        value: song.artist || 'Desconocido',
                        inline: true,
                    },
                    {
                        name: 'Género',
                        value: song.genre || 'General',
                        inline: true,
                    },
                    {
                        name: 'Fuente',
                        value: song.source || 'unknown',
                        inline: true,
                    }
                )
                .setThumbnail(song.cover_url)
                .setColor(0x2ecc71);

            await channel.send({ embeds: [songEmbed] });
            await delay(300);
        }

        if (addedSongs.length > 5) {
            await channel.send(
                `*...y ${addedSongs.length - 5} canciones más registradas.*`
            );
        }
    } catch (e) {
        console.error('Error enviando reporte a Discord:', e.message);
    }
}

// ============================================================
// SCRAPER
// ============================================================
async function runSlowScraper(maxSongsTarget = 1000, customCategory = null) {
    if (isScraperRunning) return;

    isScraperRunning = true;
    scraperCancelRequested = false;

    console.log(
        `🚀 [SCRAPER] Iniciando proceso (Objetivo: ~${maxSongsTarget} canciones)...`
    );

    const addedSongs = [];

    const targets = customCategory
        ? [{ genre: customCategory, query: customCategory }]
        : searchTargets;

    try {
        for (const target of targets) {
            if (scraperCancelRequested) {
                console.log('🛑 [SCRAPER] Cancelado por !stop');
                break;
            }

            if (addedSongs.length >= maxSongsTarget) {
                break;
            }

            console.log(
                `⏳ Buscando: [${target.genre}] -> "${target.query}"`
            );

            const scTracks = await searchSoundCloud(target.query);
            await delay(1500);

            if (scraperCancelRequested) break;

            const ytTracks = await searchYouTube(target.query);
            await delay(1500);

            if (scraperCancelRequested) break;

            const allTracks = [...scTracks, ...ytTracks];
            const batchToInsert = [];

            for (const track of allTracks) {
                const cleanTitle = track.title
                    .replace(/\[.*\]|\(.*\)/g, '')
                    .replace(
                        /Official Video|Official Audio|Video Oficial|Lyric Video|Audio|4K|HD|Remastered/gi,
                        ''
                    )
                    .trim();

                batchToInsert.push({
                    title: cleanTitle || track.title,
                    artist: track.artist || target.genre,
                    genre: target.genre,
                    duration: track.duration,
                    source: track.source,
                    audio_url: track.audio_url,
                    cover_url:
                        track.cover_url ||
                        'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=500&q=80',
                    lyrics: '[00:00.00] Letra no disponible',
                });
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
                    console.log(
                        `✅ +${data.length} agregadas de [${target.genre}]. Total sesión: ${addedSongs.length}`
                    );
                }
            }

            await delay(2500);
        }

        catalogCache.del('full_catalog');

        console.log(
            `🎉 [SCRAPER] Finalizado. Total agregadas: ${addedSongs.length}`
        );

        if (addedSongs.length > 0) {
            await sendDiscordSummary(addedSongs);
        }
    } catch (e) {
        console.error('Error en scraper:', e.message);
    } finally {
        isScraperRunning = false;
        scraperCancelRequested = false;
    }
}

// ============================================================
// CRON
// ============================================================
cron.schedule('0 21,22,23,0,1,2,3,4,5,6 * * *', () => {
    console.log('⏰ Horario nocturno activado (9 PM - 6 AM).');
    runSlowScraper(500);
});

// ============================================================
// DISCORD COMMANDS
// ============================================================
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!')) {
        return;
    }

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'status') {
        return message.reply(
            isScraperRunning
                ? '🔄 El scraper está **activo** descargando canciones.'
                : '🟢 El scraper está en **espera** (Inactivo).'
        );
    }

    if (command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle('🤖 Comandos de Sekai Music Bot')
            .setColor(0x3498db)
            .addFields(
                {
                    name: '!status',
                    value: 'Muestra el estado del scraper.',
                },
                {
                    name: '!stats',
                    value: 'Muestra el número total real de canciones en la BD.',
                },
                {
                    name: '!add [cant] [término]',
                    value: 'Agrega canciones. Ej: `!add 50 vocaloid`',
                },
                {
                    name: '!search [nombre]',
                    value: 'Busca canciones guardadas.',
                },
                {
                    name: '!trigger',
                    value: 'Fuerza la ejecución del scraper.',
                },
                {
                    name: '!stop',
                    value: 'Cancela la ejecución actual del scraper.',
                }
            );

        return message.reply({ embeds: [helpEmbed] });
    }

    if (command === 'stats') {
        const { count, error } = await supabase
            .from('songs')
            .select('*', { count: 'exact', head: true });

        if (error) {
            return message.reply('❌ Error al obtener estadísticas.');
        }

        return message.reply(
            `📊 Total en la base de datos: **${count} canciones**.`
        );
    }

    if (command === 'search') {
        const query = args.join(' ');

        if (!query) {
            return message.reply(
                '❌ Indica el nombre a buscar. Ej: `!search Eve`'
            );
        }

        const { data } = await supabase
            .from('songs')
            .select('title, artist, source')
            .or(`title.ilike.%${query}%,artist.ilike.%${query}%`)
            .limit(5);

        if (!data || data.length === 0) {
            return message.reply('🔍 No se encontraron coincidencias.');
        }

        const results = data
            .map(
                (s, i) =>
                    `${i + 1}. **${s.title}** - ${s.artist} *(${s.source})*`
            )
            .join('\n');

        return message.reply(`🎵 **Resultados:**\n${results}`);
    }

    if (command === 'trigger') {
        if (isScraperRunning) {
            return message.reply(
                '⚠️ El scraper ya se encuentra ejecutándose.'
            );
        }

        await message.reply('🚀 Forzando inicio del scraper nocturno...');
        runSlowScraper(300);
        return;
    }

    if (command === 'stop') {
        if (!isScraperRunning) {
            return message.reply('🟢 El scraper no está activo.');
        }
        scraperCancelRequested = true;
        return message.reply(
            '🛑 Cancelación solicitada. El scraper se detendrá al terminar el lote actual.'
        );
    }

    if (command === 'add') {
        const limit = parseInt(args[0]) || 50;
        const category = args.slice(1).join(' ') || null;

        if (isScraperRunning) {
            return message.reply(
                '⚠️ El scraper ya se encuentra ejecutando una descarga.'
            );
        }

        await message.reply(
            `🚀 Iniciando ingesta manual de hasta **${limit} canciones**${
                category ? ` para "${category}"` : ''
            }.`
        );

        runSlowScraper(limit, category);
    }
});

// ============================================================
// API HEALTH
// ============================================================
app.get('/api/health', (req, res) =>
    res.status(200).send('OK - Server Active')
);

// ============================================================
// HELPER: enriquecer canción con stream_url para la app
// ============================================================
function enrichSong(song) {
    if (!song || song.id == null) return song;
    return {
        ...song,
        stream_url: `${RENDER_URL}/api/v1/stream/${song.id}`,
    };
}

// ============================================================
// CATÁLOGO (con caché + stream_url)
// ============================================================
app.get('/api/v1/catalog', async (req, res) => {
    try {
        const cached = catalogCache.get('full_catalog');
        if (cached) {
            return res.json(cached);
        }

        const { count, error: countError } = await supabase
            .from('songs')
            .select('*', { count: 'exact', head: true });

        if (countError) {
            return res.status(500).json({
                status: 'error',
                message: countError.message,
            });
        }

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

            if (error) {
                return res.status(500).json({
                    status: 'error',
                    message: error.message,
                });
            }

            allSongs = allSongs.concat(data || []);

            if (!data || data.length < pageSize) {
                hasMore = false;
            } else {
                page++;
            }
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
        res.status(500).json({
            status: 'error',
            message: err.message,
        });
    }
});

// ============================================================
// SEARCH API
// ============================================================
app.get('/api/v1/search', async (req, res) => {
    try {
        const { q } = req.query;

        if (!q) {
            return res.status(400).json({
                status: 'error',
                message: 'Falta parámetro ?q=',
            });
        }

        const { data, error } = await supabase
            .from('songs')
            .select('*')
            .or(
                `title.ilike.%${q}%,artist.ilike.%${q}%,genre.ilike.%${q}%`
            )
            .limit(100);

        if (error) {
            return res.status(500).json({
                status: 'error',
                message: error.message,
            });
        }

        res.json({
            status: 'success',
            total: data.length,
            results: data.map(enrichSong),
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message,
        });
    }
});

// ============================================================
// MANUAL UPLOAD
// ============================================================
app.post('/api/upload', requireAuth, async (req, res) => {
    try {
        const {
            title,
            artist,
            duration,
            audio_url,
            cover_url,
            lyrics,
            genre,
        } = req.body;

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

        const { data, error } = await supabase
            .from('songs')
            .insert([songData])
            .select();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        catalogCache.del('full_catalog');

        res.json({
            success: true,
            song: enrichSong(data[0]),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// OBTENER STREAM DE AUDIO (YouTube / SoundCloud vía play-dl)
// ============================================================
async function getAudioStream(audioUrl) {
    if (!audioUrl || typeof audioUrl !== 'string') {
        throw new Error('audio_url inválido');
    }

    const url = audioUrl.trim();

    const isYouTube =
        url.includes('youtube.com') || url.includes('youtu.be');
    const isSoundCloud = url.includes('soundcloud.com');

    if (!isYouTube && !isSoundCloud) {
        // URL directa (mp3, m4a, etc.): devolver fetch stream
        if (url.startsWith('http')) {
            const response = await axios.get(url, {
                responseType: 'stream',
                timeout: 30000,
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                },
            });
            return response.data;
        }
        throw new Error(`Fuente no soportada: ${url}`);
    }

    console.log(`🎧 Obteniendo audio: ${url}`);

    const result = await play.stream(url, {
        quality: 2,
        discordPlayerCompatibility: false,
    });

    if (!result || !result.stream) {
        throw new Error('No se pudo obtener el stream de audio.');
    }

    return result.stream;
}

// ============================================================
// CONVERTIR STREAM → OGG/VORBIS
// ============================================================
function convertStreamToOgg(inputStream) {
    const outputStream = new PassThrough();

    const command = ffmpeg(inputStream)
        .noVideo()
        .audioCodec('libvorbis')
        .audioBitrate('128k')
        .format('ogg')
        .on('start', (commandLine) => {
            console.log('🎬 FFmpeg:', commandLine);
        })
        .on('error', (error) => {
            console.error('❌ FFmpeg:', error.message);
            outputStream.destroy(error);
        })
        .on('end', () => {
            console.log('✅ OGG terminado');
        });

    inputStream.on('error', (error) => {
        outputStream.destroy(error);
    });

    command.pipe(outputStream, { end: true });

    return outputStream;
}

// ============================================================
// ESPERAR A QUE TERMINE UN AUDIO
// ============================================================
function waitForStream(stream) {
    return new Promise((resolve, reject) => {
        let finished = false;

        const cleanup = () => {
            stream.removeListener('end', onEnd);
            stream.removeListener('finish', onEnd);
            stream.removeListener('error', onError);
            stream.removeListener('close', onClose);
        };

        const done = () => {
            if (finished) return;
            finished = true;
            cleanup();
            resolve();
        };

        const fail = (error) => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(error);
        };

        const onEnd = () => done();
        const onClose = () => {
            if (!finished) done();
        };
        const onError = (error) => fail(error);

        stream.once('end', onEnd);
        stream.once('finish', onEnd);
        stream.once('close', onClose);
        stream.once('error', onError);
    });
}

// ============================================================
// STREAM PARA LA APP FLUTTER
// GET /api/v1/stream/:id
// ============================================================
// just_audio no puede abrir youtube.com/watch?... 
// Esta ruta convierte el audio a OGG y lo sirve en vivo.
app.get('/api/v1/stream/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                status: 'error',
                message: 'ID inválido',
            });
        }

        const { data: song, error } = await supabase
            .from('songs')
            .select('id, title, audio_url, source')
            .eq('id', id)
            .maybeSingle();

        if (error) {
            return res.status(500).json({
                status: 'error',
                message: error.message,
            });
        }

        if (!song || !song.audio_url) {
            return res.status(404).json({
                status: 'error',
                message: 'Canción no encontrada',
            });
        }

        console.log(`🎧 Stream #${id}: ${song.title}`);

        const sourceStream = await getAudioStream(song.audio_url);

        res.status(200);
        res.setHeader('Content-Type', 'audio/ogg');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader(
            'Content-Disposition',
            `inline; filename="sekai_${id}.ogg"`
        );
        // Ayuda a algunos clientes a reintentar / seek básico
        res.setHeader('Accept-Ranges', 'none');

        const oggStream = convertStreamToOgg(sourceStream);

        const cleanup = () => {
            try {
                sourceStream.destroy?.();
            } catch (_) {}
            try {
                oggStream.destroy?.();
            } catch (_) {}
        };

        oggStream.on('error', (err) => {
            console.error('❌ Stream error:', err.message);
            cleanup();
            if (!res.headersSent) {
                res.status(500).end();
            } else if (!res.destroyed) {
                res.destroy(err);
            }
        });

        req.on('close', cleanup);
        res.on('close', cleanup);

        oggStream.pipe(res);
    } catch (err) {
        console.error('❌ /api/v1/stream:', err.message);
        if (!res.headersSent) {
            res.status(500).json({
                status: 'error',
                message: err.message,
            });
        }
    }
});

// ============================================================
// GENERADOR MCPACK
// GET: ?ids=1,2,3
// POST: { "song_ids": [1,2,3] }
// ============================================================
async function generateMcpack(req, res) {
    try {
        let songIds;

        if (req.method === 'GET') {
            const ids = String(req.query.ids || '').trim();

            if (!ids) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Debes indicar ?ids=1,2,3',
                });
            }

            songIds = ids
                .split(',')
                .map((id) => Number(String(id).trim()));
        } else {
            songIds = req.body?.song_ids;
        }

        if (!Array.isArray(songIds) || songIds.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'Debes enviar canciones.',
            });
        }

        songIds = [...new Set(songIds.map(Number))];

        if (songIds.some((id) => !Number.isInteger(id) || id <= 0)) {
            return res.status(400).json({
                status: 'error',
                message: 'Los IDs deben ser números enteros positivos.',
            });
        }

        if (songIds.length > 20) {
            return res.status(400).json({
                status: 'error',
                message: 'Máximo 20 canciones por MC Pack.',
            });
        }

        console.log(
            `📦 Generando MC Pack con ${songIds.length} canciones...`
        );

        const { data: songs, error } = await supabase
            .from('songs')
            .select('id,title,artist,audio_url,source')
            .in('id', songIds);

        if (error) {
            throw new Error(error.message);
        }

        if (!songs || songs.length === 0) {
            return res.status(404).json({
                status: 'error',
                message: 'No se encontraron las canciones.',
            });
        }

        const foundIds = new Set(songs.map((song) => Number(song.id)));
        const missingIds = songIds.filter(
            (id) => !foundIds.has(Number(id))
        );

        if (missingIds.length > 0) {
            return res.status(404).json({
                status: 'error',
                message: `No existen estas canciones: ${missingIds.join(', ')}`,
            });
        }

        songs.sort(
            (a, b) =>
                songIds.indexOf(Number(a.id)) -
                songIds.indexOf(Number(b.id))
        );

        res.status(200);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
            'Content-Disposition',
            'attachment; filename="SekaiMusic.mcpack"'
        );
        res.setHeader(
            'Cache-Control',
            'no-store, no-cache, must-revalidate'
        );

        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('warning', (warning) => {
            console.warn('⚠️ Archiver:', warning.message);
        });

        archive.on('error', (error) => {
            console.error('❌ Archiver:', error.message);
            if (!res.destroyed) {
                res.destroy(error);
            }
        });

        archive.pipe(res);

        const manifest = {
            format_version: 2,
            header: {
                name: '🎵 Sekai Music Pack',
                description:
                    'Música generada desde Sekai Music Server',
                uuid: uuidv4(),
                version: [1, 0, 0],
                min_engine_version: [1, 20, 0],
            },
            modules: [
                {
                    type: 'resources',
                    uuid: uuidv4(),
                    version: [1, 0, 0],
                },
            ],
        };

        archive.append(JSON.stringify(manifest, null, 2), {
            name: 'manifest.json',
        });

        const soundDefinitions = {
            format_version: '1.14.0',
            sound_definitions: {},
        };

        for (const song of songs) {
            const id = Number(song.id);
            const internalName = `sekai.track_${id}`;

            soundDefinitions.sound_definitions[internalName] = {
                category: 'record',
                sounds: [
                    {
                        name: `sounds/sekai/${id}`,
                        stream: true,
                    },
                ],
            };

            console.log(`🎵 [${id}] ${song.title}`);

            if (!song.audio_url) {
                throw new Error(
                    `La canción ${id} no tiene audio_url.`
                );
            }

            const sourceStream = await getAudioStream(song.audio_url);
            const oggStream = convertStreamToOgg(sourceStream);

            archive.append(oggStream, {
                name: `sounds/sekai/${id}.ogg`,
            });

            await waitForStream(oggStream);

            console.log(`📦 Añadido: sounds/sekai/${id}.ogg`);
        }

        archive.append(JSON.stringify(soundDefinitions, null, 2), {
            name: 'sounds/sound_definitions.json',
        });

        await archive.finalize();

        console.log('✅ SekaiMusic.mcpack generado correctamente.');
    } catch (err) {
        console.error('❌ Error generando MC Pack:', err);

        if (!res.headersSent) {
            return res.status(500).json({
                status: 'error',
                message: err.message,
            });
        }

        if (!res.destroyed) {
            res.destroy(err);
        }
    }
}

// ============================================================
// MCPACK GET + POST
// ============================================================
app.get('/api/v1/generate-mcpack', generateMcpack);
app.post('/api/v1/generate-mcpack', generateMcpack);

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, async () => {
    console.log(`🚀 Servidor activo en puerto ${PORT}`);
    console.log(`📡 Stream API: ${RENDER_URL}/api/v1/stream/:id`);

    if (process.env.DISCORD_BOT_TOKEN) {
        try {
            await discordClient.login(process.env.DISCORD_BOT_TOKEN);
            console.log('🤖 Bot de Discord conectado exitosamente');
        } catch (error) {
            console.error(
                '❌ Error al conectar el bot de Discord:',
                error.message
            );
        }
    }
});


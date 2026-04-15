import express from "express";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { Storage } from "@google-cloud/storage";

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const GCS_PROJECT_ID = process.env.GCS_PROJECT_ID;
const GCS_KEY_JSON = process.env.GCS_KEY_JSON;

if (!BUCKET_NAME || !GCS_PROJECT_ID || !GCS_KEY_JSON) {
  console.warn("Missing GCS env vars");
}

const storage = new Storage({
  projectId: GCS_PROJECT_ID,
  credentials: JSON.parse(GCS_KEY_JSON || "{}"),
});

const jobs = new Map();

async function downloadFile(url, outputPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120000,
    maxRedirects: 5,
  });

  await fs.ensureDir(path.dirname(outputPath));

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("start", (cmd) => console.log("FFmpeg command:", cmd))
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function uploadToGCS(localPath, objectName) {
  const bucket = storage.bucket(BUCKET_NAME);

  await bucket.upload(localPath, {
    destination: objectName,
    contentType: "video/mp4",
  });

  const file = bucket.file(objectName);

  await file.makePublic();

  return `https://storage.googleapis.com/${BUCKET_NAME}/${objectName}`;
}

async function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/mix-video", async (req, res) => {
  try {
    const { background_url, media_list, voice_url } = req.body?.data || {};

    if (!background_url || !Array.isArray(media_list) || media_list.length === 0 || !voice_url) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    const jobId = Date.now().toString();
    jobs.set(jobId, { status: "processing" });

    (async () => {
      const workdir = path.join(os.tmpdir(), `job-${jobId}-${uuidv4()}`);
      await fs.ensureDir(workdir);

      try {
        const audioBg = path.join(workdir, "bg.mp3");
        const audioVoice = path.join(workdir, "voice.mp3");

        await downloadFile(background_url, audioBg);
        await downloadFile(voice_url, audioVoice);

        const voiceDuration = await getAudioDuration(audioVoice);
        if (!voiceDuration || voiceDuration <= 0) {
          throw new Error("Could not determine voice audio duration");
        }

        const localMedia = [];
        for (let i = 0; i < media_list.length; i++) {
          const srcUrl = media_list[i];
          const isVideo = srcUrl.toLowerCase().includes(".mp4");
          const ext = isVideo ? "mp4" : "jpg";
          const target = path.join(workdir, `media-${i}.${ext}`);
          await downloadFile(srcUrl, target);
          localMedia.push({ path: target, isVideo });
        }

        const perItemDuration = voiceDuration / localMedia.length;
        const clipPaths = [];

        for (let i = 0; i < localMedia.length; i++) {
          const item = localMedia[i];
          const out = path.join(workdir, `clip-${i}.mp4`);

          if (item.isVideo) {
            await runFfmpeg(
              ffmpeg(item.path)
                .videoCodec("libx264")
                .outputOptions([
                  `-t ${perItemDuration}`,
                  "-pix_fmt yuv420p",
                  "-preset veryfast",
                  "-movflags +faststart",
                  "-r 24",
                  "-vf scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=24"
                ])
                .noAudio()
                .save(out)
            );
          } else {
            await runFfmpeg(
              ffmpeg(item.path)
                .inputOptions(["-loop 1"])
                .videoCodec("libx264")
                .outputOptions([
                  `-t ${perItemDuration}`,
                  "-pix_fmt yuv420p",
                  "-preset veryfast",
                  "-movflags +faststart",
                  "-r 24",
                  "-vf scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=24"
                ])
                .noAudio()
                .save(out)
            );
          }

          clipPaths.push(out);
        }

        const concatFile = path.join(workdir, "concat.txt");
        const concatContent = clipPaths
          .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
          .join("\n");
        await fs.writeFile(concatFile, concatContent, "utf8");

        const mergedVideo = path.join(workdir, "merged-video.mp4");
        await runFfmpeg(
          ffmpeg()
            .input(concatFile)
            .inputOptions(["-f concat", "-safe 0"])
            .outputOptions([
              "-c:v libx264",
              "-pix_fmt yuv420p",
              "-preset veryfast",
              "-movflags +faststart"
            ])
            .noAudio()
            .save(mergedVideo)
        );

        const mixedAudio = path.join(workdir, "mixed-audio.mp3");
        await runFfmpeg(
          ffmpeg()
            .input(audioBg)
            .input(audioVoice)
            .complexFilter([
              "[0:a]volume=0.12[bg]",
              "[1:a]volume=1.0[voice]",
              "[bg][voice]amix=inputs=2:duration=first:dropout_transition=2[aout]"
            ])
            .outputOptions(["-map [aout]"])
            .save(mixedAudio)
        );

        const finalVideo = path.join(workdir, `final-${jobId}.mp4`);
        await runFfmpeg(
          ffmpeg()
            .input(mergedVideo)
            .input(mixedAudio)
            .outputOptions([
              "-c:v copy",
              "-c:a aac",
              "-shortest",
              "-movflags +faststart"
            ])
            .save(finalVideo)
        );

        const objectName = `final-videos/final-${jobId}.mp4`;
        const publicUrl = await uploadToGCS(finalVideo, objectName);

        jobs.set(jobId, {
          status: "done",
          url: publicUrl,
        });

        await fs.remove(workdir);
      } catch (err) {
        console.error("Job failed:", err);
        jobs.set(jobId, {
          status: "error",
          error: err.message,
        });
      }
    })();

    return res.status(200).json({
      success: true,
      data: {
        id: jobId,
        status: "processing",
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Something broke",
      details: err.message,
    });
  }
});

app.get("/video-status", async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Missing id",
      });
    }

    const job = jobs.get(id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id,
        status: job.status,
        url: job.url || null,
        error: job.error || null,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Something broke",
      details: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

const cors = require("cors");
const express = require("express");
const fs = require("fs");
const http = require("http");
const dotenv = require("dotenv");
const axios = require("axios");
const { Server } = require("socket.io");
const { Readable } = require("stream");
const OpenAI = require("openai");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

dotenv.config();
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ELECTRON_HOST,
    methods: ["GET", "POST"],
  },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: process.env.AWS_REGION,
});

let recordedChunks = [];

// Start the server outside of the socket.io connection handler
server.listen(5000, () => {
  console.log("🟢 Server is running on port 5000");
});

io.on("connection", (socket) => {
  console.log("🟢 Socket is connected");

  socket.on("video-chunks", async (data) => {
    console.log("🟢 Video chunks received", data);
    const writeStream = fs.createWriteStream("temp_upload/" + data.filename);
    recordedChunks.push(data.chunks);
    const videoBlob = new Blob(recordedChunks, {
      type: "video/webm; codecs=vp9",
    });
    const buffer = Buffer.from(await videoBlob.arrayBuffer());
    const readStream = Readable.from(buffer);
    readStream.pipe(writeStream).on("finish", () => {
      console.log("🟢 Video saved successfully");
    });
  });

  socket.on("process-video", async (data) => {
    console.log("🟢 Processing video...");
    recordedChunks = [];
    fs.readFile("temp_upload/" + data.filename, async (error, file) => {
      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
        { filename: data.filename }
      );

      if (processing.data.status !== 200)
        return console.log("🔴 Error! Something went wrong processing file. ");

      const Key = data.filename;
      const Bucket = process.env.AWS_BUCKET_NAME;
      const ContentType = "video/webm";
      const command = new PutObjectCommand({
        Bucket,
        Key,
        Body: file,
        ContentType,
      });

      const fileStatus = await s3.send(command);

      if (fileStatus["$metadata"].httpStatusCode === 200) {
        console.log("🟢 Video uploaded to AWS");

        if (processing.data.plan === "PRO") {
          fs.stat("temp_upload/" + data.filename, async (err, stat) => {
            if (!err) {
              if (stat.size < 25000000) {
                const transcription = await openai.audio.transcriptions.create({
                  file: fs.createReadStream("temp_upload/" + data.filename),
                  model: "whisper-1",
                  response_format: "text",
                });

                if (transcription) {
                  const completion = await openai.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    response_format: { type: "json_object" },
                    messages: [
                      {
                        role: "system",
                        content: `You are going to generate a title and a nice description using the speech to text transcription provided: transcription(${transcription})
                                        and then return it in json format as { "title": <the title you gave>, "summary": <the summary you created>}`,
                      },
                    ],
                  });

                  const titleAndSummaryGenerated = await axios.post(
                    `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                    {
                      filename: data.filename,
                      content: completion.choices[0].message.content,
                      transcript: transcription,
                    }
                  );

                  if (titleAndSummaryGenerated.data.status !== 200) {
                    console.log(
                      "🔴 Error! Something went wrong generating title and descriptiom"
                    );
                  }
                }
              }
            }
          });
        }
        const stopProcessing = await axios.post(
          `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
          {
            filename: data.filename,
          }
        );
        if (stopProcessing.data.status !== 200) {
          console.log(
            "🔴 Error! Something went wrong while stopping processing"
          );
        }
        if (stopProcessing.status === 200) {
          fs.unlink("temp_upload/" + data.filename, (err) => {
            if (!err) {
              console.log(
                "🟢" + " " + data.filename + " " + "🟢 deleted successfully"
              );
            }
          });
        }
      } else {
        console.log("🔴 Error! Upload failed! Process aborted.");
      }
    });
  });

  socket.on("disconnect", () => {
    console.log("🟢 Socket is disconnected", socket.id);
  });
});



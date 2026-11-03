# ffmpeg recipes

Converting, cutting and shrinking audio and video files from the command line.

## Convert formats

ffmpeg -i input.mov output.mp4 converts by file extension. Add -c:v libx264 -crf 23 to choose the codec and quality;
a lower crf gives better quality and a bigger file.

## Cut a clip

ffmpeg -ss 00:01:30 -to 00:02:00 -i input.mp4 -c copy clip.mp4 keeps thirty seconds without re-encoding,
so it is fast, but the cut snaps to the nearest keyframe.

## Extract audio

ffmpeg -i talk.mp4 -vn -c:a libmp3lame -q:a 2 talk.mp3 drops the video stream and keeps the sound as MP3.

## Resize and compress

ffmpeg -i big.mp4 -vf scale=1280:-2 -crf 28 small.mp4 scales to 720p width while keeping the aspect ratio.
-preset slow squeezes the file further at the cost of encoding time.

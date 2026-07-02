FROM node:20-alpine AS assets
RUN apk add --no-cache ffmpeg ttf-dejavu
RUN F=/usr/share/fonts/dejavu && ffmpeg -y -f lavfi -i color=c=0x1a1a1a:s=854x480:d=20 -vf "\
drawtext=fontfile=$F/DejaVuSans-Bold.ttf:text=Cache:fontcolor=0xFF8C42:fontsize=56:x=261:y=140,\
drawtext=fontfile=$F/DejaVuSans-Oblique.ttf:text=Njoy:fontcolor=white:fontsize=56:x=452:y=140,\
drawtext=fontfile=$F/DejaVuSans-Bold.ttf:text=Stream failed:fontcolor=0xFF8C42:fontsize=42:x=(w-text_w)/2:y=260,\
drawtext=fontfile=$F/DejaVuSans.ttf:text=Try another source:fontcolor=0xFF8C42:fontsize=26:x=(w-text_w)/2:y=335\
" -c:v libx264 -pix_fmt yuv420p -movflags +faststart /fail.mp4

FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js config.js settings.js admin.html cleanup-worker.js ./
COPY backends ./backends
COPY --from=assets /fail.mp4 ./assets/fail.mp4
EXPOSE 4040
CMD ["node", "server.js"]

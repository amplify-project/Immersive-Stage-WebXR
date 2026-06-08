Video Encoding/Muxing:
ffmpeg -i video.mov -an -map_metadata -1 -map_chapters -1 -map 0:v -c:v libx264 -
preset veryfast -f dash -seg_duration 2 -use_template 1 -use_timeline 1 -
init_seg_name video-init.webm -media_seg_name video-chunk-$Number%05d$
encoded/video.mpd
Audio Encoding/Muxing:
ffmpeg -i audio.wav -vn -map 0:a -c:a libopus -mapping_family 255 -b:a 160k -f

dash -seg_duration 2 -use_template 1 -use_timeline 1 -init_seg_name audio-
init.webm -media_seg_name audio-chunk-$Number%05d$ encoded/audio.mpd

Duplicate Stream:
ffmpeg -i "srt://127.0.0.1:5000?mode=listener" -c copy -f mpegts
"udp://127.0.0.1:5001" -c copy -f mpegts "udp://127.0.0.1:5002"
Video live mux
ffmpeg -i "udp://127.0.0.1:5001?mode=listener" -an -map 0:v:0 -c:v libx264 -
preset veryfast -f dash -seg_duration 2 -window_size 5 -use_template 1 -

use_timeline 1 -streaming 1 -init_seg_name video-init.webm -media_seg_name video-
chunk-$Number%05d$ encoded/video.mpd

Audio live mux
ffmpeg -i "udp://127.0.0.1:5002?mode=listener" -vn -map 0:a:0 -c:a libopus -
mapping_family 255 -b:a 160k -f dash -seg_duration 2 -window_size 5 -use_template
1 -use_timeline 1 -streaming 1 -init_seg_name audio-init.webm -media_seg_name
audio-chunk-$Number%05d$ encoded/audio.mpd
Dual Encoding/Muxing:
ffmpeg -stream_loop -1 -re -i video.mov -stream_loop -1 -re -i audio.wav -map

0:v:0 -map 1:a:0 -c:v libvpx-vp9 -b:v 4000k -deadline realtime -cpu-used 5 -row-
mt 1 -threads 8 -tile-columns 2 -frame-parallel 1 -speed 5 -maxrate 4000k -

bufsize 8000k -c:a libopus -b:a 320k -ac 4 -channel_layout quad -f dash -
dash_segment_type webm -seg_duration 4 -use_timeline 1 -use_template 1 -
adaptation_sets 'id=0,streams=0 id=1,streams=1' -init_seg_name
'init_$RepresentationID$.webm' -media_seg_name
'seg_$RepresentationID$_$Number%05d$.webm' -window_size 5 encoded/manifest.mpd
ffmpeg -i video.mov -i audio.wav -map_metadata -1 -map_chapters -1 -map 0:v:0 -
map 1:a:0 -c:v libvpx-vp9 -c:a libopus -b:a 160k -mapping_family 255 -f dash -
dash_segment_type webm -use_template 1 -use_timeline 1 -adaptation_sets
"id=0,streams=0 id=1,streams=1" -t 00:00:20 encoded/manifest.mpd

import requests
import time

payload = {
    "frames": [
        {
            "scene": {
                "scene_number": 1,
                "setting": "EXT. FOREST - DAY",
                "narration": "This is a test narration.",
                "dialogue": [],
                "transition": "CUT TO",
                "visual_description": "A sunny forest.",
                "shot_type": "WIDE",
                "camera_movement": "STATIC",
                "duration": 4,
                "style": "Cinematic",
                "seed": 42,
                "image_url": "https://image.pollinations.ai/prompt/sunny%20forest"
            },
            "image_url": "https://image.pollinations.ai/prompt/sunny%20forest"
        }
    ],
    "global_seed": 42,
    "title": "Test"
}

r = requests.post("http://localhost:8000/api/export", json=payload)
print(r.json())
task_id = r.json()["task_id"]

while True:
    r = requests.get(f"http://localhost:8000/api/export/status/{task_id}")
    print(r.json())
    if r.json()["status"] in ["completed", "failed"]:
        break
    time.sleep(2)

import numpy as np
import os
import glob

cam_dir = "/data/FrameCullModelLab/incoming/camera-previews-384/"
aud_dir = "/data/FrameCullModelLab/incoming/raw-audit-previews/"
print("cam_count=", len(glob.glob(cam_dir + "*.jpg")))
print("audit_count=", len(glob.glob(aud_dir + "*.jpg")))

for tag in ["teacher-camera", "teacher-audit3groups"]:
    p = f"/data/FrameCullModelLab/features/teacher/{tag}.npz"
    if not os.path.exists(p):
        print(tag, "MISSING")
        continue
    d = np.load(p, allow_pickle=True)
    print(tag, {k: (d[k].shape, str(d[k].dtype)) for k in d.files})
    print("  stem0=", d["stems"][0], "tech0=", round(float(d["musiq_tech"][0]), 2),
          "aes0=", round(float(d["musiq_aes"][0]), 2))

# label coverage
import json
cam_lab = "/data/FrameCullModelLab/incoming/camera-labels/camera-labels-final.json"
if os.path.exists(cam_lab):
    j = json.load(open(cam_lab))
    recs = j.get("records", j)
    dist = {}
    for k, v in recs.items():
        r = v.get("rating") if isinstance(v, dict) else v
        dist[r] = dist.get(r, 0) + 1
    print("camera label dist=", dict(sorted(dist.items(), key=lambda x: str(x[0]))))
aud_lab = "/data/FrameCullModelLab/incoming/raw-audit-previews/labels.json"
if os.path.exists(aud_lab):
    j = json.load(open(aud_lab))
    recs = j.get("records", j)
    print("audit label count=", len(recs) if isinstance(recs, dict) else "n/a")

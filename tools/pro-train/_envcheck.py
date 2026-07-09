import scipy
import timm
import torch
import PIL
import numpy

print("scipy", scipy.__version__, "timm", timm.__version__, "torch", torch.__version__)
print("cuda_avail", torch.cuda.is_available(),
      torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu")
print("convnext_tiny", "convnext_tiny" in timm.list_models("convnext_tiny"))
deit = timm.list_models("deit*tiny*")
print("deit_tiny_candidates", deit[:6])

from pathlib import Path
import uuid

import numpy as np
from PIL import Image
import folder_paths


class ImageEditCompare:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {},
                'optional': {'image_a': ('IMAGE',), 'image_b': ('IMAGE',)}}

    RETURN_TYPES = ()
    FUNCTION = 'compare'
    CATEGORY = 'MediaAB'
    OUTPUT_NODE = True
    DESCRIPTION = 'Compare two images with a sliding divider, side by side, or by switching between them.'

    def compare(self, image_a=None, image_b=None, label_a='A · 原图', label_b='B · 处理后'):
        directory = Path(folder_paths.get_temp_directory()) / 'image_ab'
        directory.mkdir(parents=True, exist_ok=True)
        clips = []
        for image, label in ((image_a, label_a), (image_b, label_b)):
            if image is None:
                clips.append(None)
                continue
            pixels = np.clip(image[0].detach().cpu().numpy() * 255, 0, 255).round().astype(np.uint8)
            filename = uuid.uuid4().hex + '.png'
            Image.fromarray(pixels).save(directory / filename, compress_level=1)
            clips.append({'filename': filename, 'subfolder': 'image_ab', 'type': 'temp', 'label': label})
        return {'ui': {'image_ab': clips}}

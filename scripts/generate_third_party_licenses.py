# -*- coding: utf-8 -*-
"""THIRD_PARTY_LICENSES.txt 생성 — JS(license-checker) + Python(dist-info) 라이선스 전문 수집.

사용: 프로젝트 루트에서
  uv run --with --directory export-sidecar ... 대신 직접:
  cd export-sidecar && uv run python ../scripts/generate_third_party_licenses.py
(또는 .venv의 python으로 직접 실행 — 표준 라이브러리만 사용)

[4] 웹 버전 AI 구성요소 절만 고칠 때(사이드카 환경 불필요):
  python scripts/generate_third_party_licenses.py --web-ai-only
기존 파일의 [1]~[3]은 그대로 두고 [4]만 교체한 뒤 web/public 사본을 맞춘다.
"""
import json
import re
import subprocess
import sys
from email.parser import Parser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "resources" / "THIRD_PARTY_LICENSES.txt"
WEB_OUT = ROOT / "web" / "public" / "THIRD_PARTY_LICENSES.txt"
SITE = ROOT / "export-sidecar" / ".venv" / "Lib" / "site-packages"

HEADER = """DTF GangSheet Studio — Third-Party Open Source Licenses
=========================================================

This product includes software developed by third parties under the licenses
below. Each entry lists the package name, version, license and its full text
(where available). Notices are provided in lieu of individual attribution.

Sections:
  [1] Node.js dependencies (renderer + main process)
  [2] Python sidecar dependencies (image processing / background removal)
  [3] Bundled AI model weights
  [4] Web version: in-browser AI runtime and models (downloaded at first use)

"""

MODEL_NOTE = """[3] Bundled AI model weights
---------------------------
- isnet-general-use (DIS -- IS-Net general use segmentation, rembg session)
  Source: https://github.com/xuebinqin/DIS
  License: Apache License 2.0 (full text below)

- realesrgan-x4plus (Real-ESRGAN x4plus, ONNX conversion bundled as RealESRGAN_x4.onnx)
  Source: https://github.com/xinntao/Real-ESRGAN (weights)
          https://huggingface.co/anakhiu/realesrgan-onnx (ONNX conversion)
  License: BSD 3-Clause (full text below)

- RealESR-AnimeVideo-v3 (Real-ESRGAN AnimeVideo v3 x4, bundled as
  RealESR-AnimeVideo-x4.onnx)
  Source: https://github.com/xinntao/Real-ESRGAN (weights)
          https://huggingface.co/tidus2102/Real-ESRGAN (ONNX conversion)
  License: BSD 3-Clause (full text below)

--- BSD 3-Clause (Real-ESRGAN models) ---
Copyright (c) 2021, Xintao Wang.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  Apache License
                            Version 2.0, January 2004
                         http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
   and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
   the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
   other entities that control, are controlled by, or are under common
   control with that entity. For the purposes of this definition,
   "control" means (i) the power, direct or indirect, to cause the
   direction or management of such entity, whether by contract or
   otherwise, or (ii) ownership of fifty percent (50%) or more of the
   outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
   exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
   including but not limited to software source code, documentation
   source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
   transformation or translation of a Source form, including but
   not limited to compiled object code, generated documentation,
   and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
   Object form, made available under the License, as indicated by a
   copyright notice that is included in or attached to the work
   (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
   form, that is based on (or derived from) the Work and for which the
   editorial revisions, annotations, elaborations, or other modifications
   represent, as a whole, an original work of authorship. For the purposes
   of this License, Derivative Works shall not include works that remain
   separable from, or merely link (or bind by name) to the interfaces of,
   the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
   the original version of the Work and any modifications or additions
   to that Work or Derivative Works thereof, that is intentionally
   submitted to Licensor for inclusion in the Work by the copyright owner
   or by an individual or Legal Entity authorized to submit on behalf of
   the copyright owner. For the purposes of this definition, "submitted"
   means any form of electronic, verbal, or written communication sent
   to the Licensor or its representatives, including but not limited to
   communication on electronic mailing lists, source code control systems,
   and issue tracking systems that are managed by, or on behalf of, the
   Licensor for the purpose of discussing and improving the Work, but
   excluding communication that is conspicuously marked or otherwise
   designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
   on behalf of whom a Contribution has been received by Licensor and
   subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
   worldwide, non-exclusive, no-charge, royalty-free, irrevocable
   copyright license to reproduce, prepare Derivative Works of,
   publicly display, publicly perform, sublicense, and distribute the
   Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
   worldwide, non-exclusive, no-charge, royalty-free, irrevocable
   (except as stated in this section) patent license to make, have made,
   use, offer to sell, sell, import, and otherwise transfer the Work,
   where such license applies only to those patent claims licensable
   by such Contributor that are necessarily infringed by their
   Contribution(s) alone or by combination of their Contribution(s)
   with the Work to which such Contribution(s) was submitted. If You
   institute patent litigation against any entity (including a
   cross-claim or counterclaim in a lawsuit) alleging that the Work
   or a Contribution incorporated within the Work constitutes direct
   or contributory patent infringement, then any patent licenses
   granted to You under this License for that Work shall terminate
   as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
   Work or Derivative Works thereof in any medium, with or without
   modifications, and in Source or Object form, provided that You
   meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
   may provide additional or different license terms and conditions
   for use, reproduction, or distribution of Your modifications, or
   for any such Derivative Works as a whole, provided Your use,
   reproduction, and distribution of the Work otherwise complies with
   the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
   any Contribution intentionally submitted for inclusion in the Work
   by You to the Licensor shall be under the terms and conditions of
   this License, without any additional terms or conditions.
   Notwithstanding the above, nothing herein shall supersede or modify
   the terms of any separate license agreement you may have executed
   with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
   except as required for reasonable and customary use in describing the
   origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
   Contributor provides its Contributions) on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
   implied, including, without limitation, any warranties or conditions
   of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
   PARTICULAR PURPOSE. You are solely responsible for determining the
   appropriateness of using or redistributing the Work and assume any
   risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
   unless required by applicable law (such as deliberate and grossly
   negligent acts) or agreed to in writing, shall any Contributor be
   liable to You for damages, including any direct, indirect, special,
   incidental, or consequential damages of any character arising as a
   result of this License or out of the use or inability to use the
   Work (including but not limited to damages for loss of goodwill,
   work stoppage, computer failure or malfunction, or any and all
   other commercial damages or losses), even if such Contributor
   has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
   and charge a fee for, acceptance of support, warranty, indemnity,
   or other liability obligations and/or rights consistent with this
   License. However, in accepting such obligations, You may act only
   on Your own behalf and on Your sole responsibility, not on behalf
   of any other Contributor, and only if You agree to indemnify,
   defend, and hold each Contributor harmless for any liability
   incurred by, or claims asserted against, such Contributor by reason
   of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
"""


def collect_node() -> str:
    raw = subprocess.run(
        ["npx", "license-checker", "--production", "--json"],
        cwd=str(ROOT), capture_output=True, text=True, shell=(sys.platform == "win32"),
    ).stdout
    entries = []
    for name_ver, info in sorted(json.loads(raw or "{}").items()):
        name = re.sub(r"@\D[^@]*$", "", name_ver)
        license_name = info.get("licenses", info.get("license", "UNKNOWN"))
        text = info.get("licenseText", "").strip()
        entries.append(f"--- {name_ver} ({license_name}) ---\n{text or f"[License: {license_name}]"}")
    return "\n\n".join(entries)


LICENSE_FILE_PATTERNS = ("LICENSE", "LICENSE.txt", "LICENSE.md", "LICENSE.rst",
                         "COPYING", "COPYING.txt", "COPYING.LESSER", "LICENCE")


def collect_python() -> str:
    entries = []
    for dist in sorted(SITE.glob("*.dist-info")):
        metadata = dist / "METADATA"
        if not metadata.exists():
            continue
        headers = Parser().parsestr(metadata.read_text("utf-8", errors="replace").split("\n\n", 1)[0])
        name, version = headers.get("Name", dist.stem), headers.get("Version", "?")
        if name == "export-sidecar":
            continue
        lic = headers.get("License-Expression") or headers.get("License", "UNKNOWN")
        lic = " ".join(lic.split()) if isinstance(lic, str) else lic
        text = ""
        for pattern in LICENSE_FILE_PATTERNS:
            candidate = dist / pattern
            if candidate.exists():
                text = candidate.read_text("utf-8", errors="replace").strip()
                break
        if not text:
            body = metadata.read_text("utf-8", errors="replace")
            m = re.search(r"^License: (.*?)(?=\n[A-Za-z-]+:|\Z)", body, re.S | re.M)
            if m and len(m.group(1).strip()) > 80:
                text = m.group(1).strip()
        entries.append(f"--- {name} {version} ({lic}) ---\n{text or f'[License: {lic}]'}")
    return "\n\n".join(entries)


WEB_AI_MARK = "[4] Web version: in-browser AI runtime and models"

WEB_AI_NOTE = WEB_AI_MARK + """
-------------------------------------------------------
The web (browser) build runs background removal and upscaling on the user's
device. The runtime below is bundled with the web build; model weights are NOT
bundled -- they are downloaded once from the listed source at first use and
cached by the browser. Images never leave the device.

Runtime (bundled)
- onnxruntime-web 1.31.1 -- MIT License, Copyright (c) Microsoft Corporation
  https://github.com/microsoft/onnxruntime
  Bundled dependencies of onnxruntime-web:
    onnxruntime-common 1.31.1 (MIT), flatbuffers 25.x (Apache-2.0),
    protobufjs 7.x (BSD-3-Clause), long 5.x (Apache-2.0),
    guid-typescript 1.0.9 (ISC), platform 1.3.6 (MIT)

Model weights (downloaded at first use, revision pinned)
- IS-Net general use (background removal)
  Weights: https://huggingface.co/imgly/isnet-general-onnx  -- MIT License
           revision 440dea96dd4a3b06bbbf5abec3e26569dd7ec49f
           (onnx/model_fp16.onnx for WebGPU, onnx/model.onnx for WASM)
  Research: Highly Accurate Dichotomous Image Segmentation (DIS),
            Xuebin Qin et al. -- https://github.com/xuebinqin/DIS (Apache-2.0)

- realesr-general-x4v3 (upscaling, "general" engine)
  Weights: https://huggingface.co/TheGuy444/Real-ESRGAN-ONNX  -- BSD 3-Clause
           revision 4c80f3da1a8a85f0757a9e7f79e08d0307220eb5
  Original: https://github.com/xinntao/Real-ESRGAN -- BSD 3-Clause,
            Copyright (c) 2021, Xintao Wang

- RealESR-AnimeVideo-v3 x4 (upscaling, "anime" engine)
  Weights: https://huggingface.co/tidus2102/Real-ESRGAN  -- BSD 3-Clause
           revision c9a1cd990b587ccf20be2373fad8eb021e24ab01
  Original: https://github.com/xinntao/Real-ESRGAN -- BSD 3-Clause,
            Copyright (c) 2021, Xintao Wang

The BSD 3-Clause and Apache 2.0 full texts are reproduced in section [3].

--- MIT License (onnxruntime-web, onnxruntime-common, imgly/isnet-general-onnx) ---
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

#: v0.5.0 초판에서 web/public 사본에만 손으로 붙였던 임시 절의 시작 문구(재생성 시 제거)
_LEGACY_WEB_MARK = "웹 버전 추가 구성요소"
_SECTIONS_LINE = "  [3] Bundled AI model weights\n"
_SECTIONS_WEB_LINE = (
    "  [4] Web version: in-browser AI runtime and models (downloaded at first use)\n"
)


def with_web_ai_section(text: str) -> str:
    """기존 고지 본문에서 [4](및 임시 절)를 걷어내고 최신 [4]를 붙인다."""
    text = text.replace("\r\n", "\n")
    for mark in (WEB_AI_MARK + "\n---", _LEGACY_WEB_MARK):
        idx = text.find(mark)
        if idx != -1:
            text = text[:idx]
    # 임시 절 앞의 구분선(=== 줄)까지 정리
    text = text.rstrip("\n").rstrip("=").rstrip("\n")
    if _SECTIONS_WEB_LINE not in text and _SECTIONS_LINE in text:
        text = text.replace(_SECTIONS_LINE, _SECTIONS_LINE + _SECTIONS_WEB_LINE, 1)
    return text + "\n\n\n" + WEB_AI_NOTE


def write_outputs(text: str) -> None:
    """데스크톱 번들용 원본과 웹 공개 사본을 같은 내용으로 기록한다."""
    for path in (OUT, WEB_OUT):
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {path} ({path.stat().st_size // 1024} KB)")


def main() -> None:
    if "--web-ai-only" in sys.argv:
        write_outputs(with_web_ai_section(OUT.read_text(encoding="utf-8")))
        return
    node = collect_node()
    py = collect_python()
    write_outputs(
        with_web_ai_section(
            HEADER
            + "[1] Node.js dependencies\n-------------------------\n\n" + node
            + "\n\n\n[2] Python sidecar dependencies\n-------------------------------\n\n" + py
            + "\n\n\n" + MODEL_NOTE
        )
    )


if __name__ == "__main__":
    main()

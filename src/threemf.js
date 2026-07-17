// 3MF export with per-block color, for multi-color printing on a Bambu Lab
// printer + AMS. A 3MF is a ZIP archive of XML; the mesh lives in
// 3D/3dmodel.model. Color comes from the 3MF *materials* extension: a
// <basematerials> group defines one entry per palette color used, and each
// <triangle> references one via pid (group id) + p1 (material index).
//
// Geometry is produced by the SAME buildMesh() the STL uses, so the printed
// shape is byte-for-byte identical — the 3MF just adds color labels on the
// exterior faces. Bambu Studio opens it already colored and maps each color
// to an AMS slot.

import { buildMesh } from './geometry.js';
import { makeZip } from './zip.js';
import { PALETTE } from './palette.js';

const MATERIALS_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
function colorToSRGB(hex) {
  // Palette hex like "#ff5252" -> "FF5252FF" (RGBA, opaque) for 3MF.
  const h = hex.replace('#', '');
  return `${h.toUpperCase()}FF`;
}

// Round to microns as a short decimal string, dropping trailing zeros so the
// XML stays compact and parsers stay happy.
function fmt(n) {
  const s = n.toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
}

/**
 * @param {Array} cells - rows [x, y, z, color, shape?, rot?]
 * @param {number} mm - edge length of one block, in millimeters
 * @param {string} [name] - model title
 * @returns {Uint8Array} the .3mf file bytes
 */
export function blocksTo3MF(cells, mm, name = 'CraftPrint model') {
  const { triangles } = buildMesh(cells, mm);

  // Distinct colors actually used, in first-seen order -> material indices.
  const colorOrder = [];
  const colorIndexToMat = new Map();
  for (const t of triangles) {
    if (!colorIndexToMat.has(t.color)) {
      colorIndexToMat.set(t.color, colorOrder.length);
      colorOrder.push(t.color);
    }
  }
  if (colorOrder.length === 0) { colorOrder.push(0); colorIndexToMat.set(0, 0); }

  // Dedupe vertices so shared corners collapse (smaller file, cleaner mesh).
  const vertKey = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
  const vertIndex = new Map();
  const verts = [];
  function vid(p) {
    const k = vertKey(p);
    let i = vertIndex.get(k);
    if (i === undefined) { i = verts.length; vertIndex.set(k, i); verts.push(p); }
    return i;
  }
  const tris = triangles.map((t) => ({
    a: vid(t.v[0]), b: vid(t.v[1]), c: vid(t.v[2]),
    mat: colorIndexToMat.get(t.color),
  }));

  // --- XML pieces ---
  const materialsXML = colorOrder
    .map((ci) => {
      const p = PALETTE[ci] || PALETTE[0];
      return `      <base name="${escapeXml(p.name)}" displaycolor="#${colorToSRGB(p.hex)}" />`;
    })
    .join('\n');

  const vertsXML = verts
    .map((p) => `        <vertex x="${fmt(p[0])}" y="${fmt(p[1])}" z="${fmt(p[2])}" />`)
    .join('\n');

  // pid points at the basematerials group (id 1); p1 is the material index.
  const trisXML = tris
    .map((t) => `        <triangle v1="${t.a}" v2="${t.b}" v3="${t.c}" pid="1" p1="${t.mat}" />`)
    .join('\n');

  const model =
`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:m="${MATERIALS_NS}">
  <metadata name="Title">${escapeXml(name)}</metadata>
  <metadata name="Application">CraftPrint</metadata>
  <resources>
    <m:basematerials id="1">
${materialsXML}
    </m:basematerials>
    <object id="2" type="model" pid="1" pindex="0">
      <mesh>
        <vertices>
${vertsXML}
        </vertices>
        <triangles>
${trisXML}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="2" />
  </build>
</model>
`;

  // Required 3MF package files.
  const contentTypes =
`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>
`;
  const rels =
`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>
`;

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: '3D/3dmodel.model', data: model },
  ]);
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

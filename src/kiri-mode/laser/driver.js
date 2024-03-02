/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

// dep: geo.polygons
// dep: geo.point
// dep: kiri.slice
// use: kiri.pack
// use: kiri.render
gapp.register("kiri-mode.laser.driver", [], (root, exports) => {

const { base, kiri } = root;
const { driver, newSlice } = kiri;
const { FDM, CAM } = driver;
const { polygons, newPoint } = base;

const POLY = polygons;
const LASER = driver.LASER = {
    init,
    slice,
    prepare,
    export: exportLaser,
    exportGCode,
    exportSVG,
    exportDXF
};

function init(kiri, api) {
    api.event.on("settings.saved", (settings) => {
        let ui = kiri.api.ui;
        ui.knife.marker.style.display = ui.knifeOn.checked ? '' : 'none';
    });
}

/**
 * DRIVER SLICE CONTRACT
 *
 * @param {Object} settings
 * @param {Widget} Widget
 * @param {Function} onupdate (called with % complete and optional message)
 * @param {Function} ondone (called when complete with an array of Slice objects)
 */
function slice(settings, widget, onupdate, ondone) {
    let proc = settings.process;
    let offset = proc.laserOffset || 0;
    let color = settings.controller.dark ? 0xbbbbbb : 0;

    if (proc.laserSliceHeight < 0) {
        return ondone("invalid slice height");
    }

    let { laserSliceSingle, laserSliceHeight, laserSliceHeightMin } = proc;
    let bounds = widget.getBoundingBox();
    let points = widget.getPoints();
    let indices = [];

    base.slice(points, {
        zMin: bounds.min.z,
        zMax: bounds.max.z,
        zGen(zopt) {
            let { zMin, zMax, zIndexes } = zopt;
            if (laserSliceSingle) {
                indices = [ laserSliceHeight ];
            } else if (laserSliceHeight) {
                for (let z = zMin + laserSliceHeight / 2; z < zMax; z += laserSliceHeight) {
                    indices.push(z);
                }
                indices;
            } else {
                for (let i = 1; i < zIndexes.length; i++) {
                    indices.push((zIndexes[i-1] + zIndexes[i]) / 2);
                }
                // discard layers too
                if (laserSliceHeightMin) {
                    let last;
                    indices = indices.filter(v => {
                        let ok = true;
                        if (last !== undefined && Math.abs(v - last) < laserSliceHeightMin) {
                            ok = false;
                        } else {
                            last = v;
                        }
                        return ok;
                    });
                }
            }
            return indices;
        },
        onupdate(v) {
            onupdate(v);
        }
    }).then(output => {
        let slices = widget.slices = output.slices.map(data => {
            let { z, lines, groups } = data;
            let tops = POLY.nest(groups);
            let slice = newSlice(z).addTops(tops);
            slice.index = indices.indexOf(z);
            let offsets = slice.offset = offset ?
                POLY.offset(tops, offset, {z: slice.z, miter: 2 / offset}) : tops;
            slice.output().setLayer("layer", { line: 0x888800 }).addPolys(tops);
            slice.output().setLayer("cut", { line: color }).addPolys(offsets);
            return slice;
        });
        ondone();
    });
};

function polyLabel(poly, label) {
    console.log('label', label);
}

function sliceEmitObjects(print, slice, groups, opt = { }) {
    let start = newPoint(0,0,0);
    let process = print.settings.process;
    let grouped = process.outputLaserGroup;
    let stacked = process.outputLaserStack;
    let label = false && process.outputLaserLabel;
    let simple = opt.simple || false;
    let group = [];
    let emit = { in: [], out: [], mark: [] };
    let lastEmit = opt.lastEmit;
    let zcolor = print.settings.process.outputLaserZColor;

    group.thick = slice.thick;

    function laserOut(poly, group, type, index) {
        if (!poly) {
            return;
        }
        if (Array.isArray(poly)) {
            poly.forEach((pi, index) => {
                laserOut(pi, group, type, offset.length > 1 ? index : undefined);
            });
        } else {
            let pathOpt = zcolor ? {extrude: slice.z, rate: slice.z} : {extrude: 1, rate: 1};
            if (type === "mark") {
                pathOpt.rate = 0.001;
                pathOpt.extrude = 2;
            } else if (label && type === "out") {
                let lbl = index !== undefined ? `${slice.index}-${index}` : `${slice.index}`;
                polyLabel(poly, lbl);
            }
            if (simple) pathOpt.simple = true;
            if (poly.open) pathOpt.open = true;
            emit[type].push(poly);
            print.polyPrintPath(poly, start, group, pathOpt);
            if (stacked && type === "out" && lastEmit) {
                for (let out of lastEmit.out) {
                    if (out.isInside(poly)) {
                        laserOut(out, group, "mark");
                    }
                }
            }
        }
    }

    let offset = slice.offset;
    let inner = offset.map(poly => poly.inner || []).flat();

    // cut inside before outside
    laserOut(inner, group, "in");
    laserOut(offset, group, "out");

    if (!grouped) {
        groups.push(group);
        group = [];
        group.thick = slice.thick;
    }

    if (grouped) {
        groups.push(group);
    }

    return emit;
};

/**
 * DRIVER PRINT CONTRACT
 *
 * @param {Object} print state object
 * @param {Function} update incremental callback
 */
async function prepare(widgets, settings, update) {
    let device = settings.device,
        process = settings.process,
        print = self.worker.print = kiri.newPrint(settings, widgets),
        knifeOn = process.knifeOn,
        knifeDepth = process.outputKnifeDepth,
        knifePasses = process.outputKnifePasses,
        knifeTipOff = process.outputKnifeTip,
        output = print.output = [],
        totalSlices = 0,
        slices = 0;

    // filter ignored widgets
    widgets = widgets.filter(w => !w.track.ignore && !w.meta.disabled);

    function arc(center, s1, s2, out) {
        let a1 = s1.angle;
        let a2 = s2.angle;
        let diff = s1.angleDiff(s2,true);
        let step = 5;
        let ticks = Math.abs(Math.floor(diff / step));
        let dir = Math.sign(diff);
        let off = (diff % step) / 2;
        if (off == 0) {
            ticks++;
        } else {
            out.push( center.projectOnSlope(s1, knifeTipOff) );
        }
        while (ticks-- > 0) {
            out.push( center.projectOnSlope(base.newSlopeFromAngle(a1 + off), knifeTipOff) );
            a1 += step * dir;
        }
        out.push( center.projectOnSlope(s2, knifeTipOff) );
    }

    // start to the "left" of the first point
    function addKnifeRadii(poly) {
        poly.setClockwise();
        let oldpts = poly.points.slice();
        // find leftpoint and make that the first point
        let start = oldpts[0];
        let startI = 0;
        for (let i=1; i<oldpts.length; i++) {
            let pt = oldpts[i];
            if (pt.x < start.x || pt.y > start.y) {
                start = pt;
                startI = i;
            }
        }
        if (startI > 0) {
            oldpts = oldpts.slice(startI,oldpts.length).appendAll(oldpts.slice(0,startI));
        }

        let lastpt = oldpts[0].clone().move({x:-knifeTipOff,y:0,z:0});
        let lastsl = lastpt.slopeTo(oldpts[0]).toUnit();
        let newpts = [ lastpt, lastpt = oldpts[0] ];
        let tmp;
        for (let i=1; i<oldpts.length + 1; i++) {
            let nextpt = oldpts[i % oldpts.length];
            let nextsl = lastpt.slopeTo(nextpt).toUnit();
            if (lastsl.angleDiff(nextsl) >= 10) {
                if (lastpt.distTo2D(nextpt) >= knifeTipOff) {
                    arc(lastpt, lastsl, nextsl, newpts);
                } else {
                    // todo handle short segments
                    // newpts.push(lastpt.projectOnSlope(lastsl, knifeTipOff) );
                    // newpts.push( lastpt.projectOnSlope(nextsl, knifeTipOff) );
                }
            }
            newpts.push(nextpt);
            lastsl = nextsl;
            lastpt = nextpt;
        }
        newpts.push( tmp = lastpt.projectOnSlope(lastsl, knifeTipOff) );
        newpts.push( tmp.clone().move({x:knifeTipOff, y:0, z: 0}) );
        poly.open = true;
        poly.points = newpts;
    }

    // find max layers (for updates)
    widgets.forEach(function(widget) {
        totalSlices += widget.slices.length;
    });

    // emit objects from each slice into output array
    widgets.forEach(function(widget) {
        // slice stack merging
        if (process.outputLaserMerged) {
            let merged = [];
            widget.slices.forEach(function(slice) {
                let polys = [];
                slice.offset.clone(true).forEach(p => p.flattenTo(polys));
                polys.forEach(p => {
                    let match = false;
                    for (let i=0; i<merged.length; i++) {
                        let mp = merged[i];
                        if (p.isEquivalent(mp)) {
                            // increase weight
                            match = true;
                            mp.depth++;
                        }
                    }
                    if (!match) {
                        p.depth = 1;
                        merged.push(p);
                    }
                });
                update((slices++ / totalSlices) * 0.5, "prepare");
            });
            let start = newPoint(0,0,0);
            let gather = [];
            merged.forEach(poly => {
                if (knifeOn) {
                    addKnifeRadii(poly);
                }
                print.polyPrintPath(poly, start, gather, {
                    extrude: poly.depth,
                    rate: poly.depth * 10
                });
            });
            output.push(gather);
        } else {
            if (knifeOn) {
                widget.slices.forEach(slice => {
                    slice.offset.forEach(poly => {
                        addKnifeRadii(poly);
                        if (poly.inner) poly.inner.forEach(ip => {
                            addKnifeRadii(ip);
                        });
                    });
                });
            }
            let lastEmit;
            for (let slice of widget.slices.reverse()) {
                lastEmit = sliceEmitObjects(print, slice, output, {simple: knifeOn, lastEmit});
                update((slices++ / totalSlices) * 0.5, "prepare");
            }
        }
    });

    let pack = true;

    // compute tile width / height
    output.forEach(function(layerout) {
        let min = {w:Infinity, h:Infinity}, max = {w:-Infinity, h:-Infinity}, p;
        layerout.forEach(function(out) {
            p = out.point;
            out.point = p.clone(); // b/c first/last point are often shared
            min.w = Math.min(min.w, p.x);
            max.w = Math.max(max.w, p.x);
            min.h = Math.min(min.h, p.y);
            max.h = Math.max(max.h, p.y);
        });
        layerout.w = max.w - min.w;
        layerout.h = max.h - min.h;
        // shift objects to top/left of w/h bounds
        if (pack)
        layerout.forEach(function(out) {
            p = out.point;
            p.x -= min.w;
            p.y -= min.h;
        });
    });

    // do object layout packing
    let i, m, e,
        dw = device.bedWidth / 2,
        dh = device.bedDepth / 2,
        sort = !process.outputLaserLayer,
        // sort objects by size when not using laser layer ordering
        c = sort ? output.sort(kiri.Sort) : output,
        p = new kiri.Pack(dw, dh, process.outputTileSpacing).fit(c, !sort);

    // test different ratios until packed
    while (!p.packed) {
        dw *= 1.1;
        dh *= 1.1;
        p = new kiri.Pack(dw, dh, process.outputTileSpacing).fit(c ,!sort);
    }

    if (pack)
    for (i = 0; i < c.length; i++) {
        m = c[i];
        m.fit.x += m.w + p.pad;
        m.fit.y += m.h + p.pad;
        m.forEach(function(o, i) {
            // because first point emitted twice (begin/end)
            e = o.point;
            e.x += p.max.w / 2 - m.fit.x;
            e.y += p.max.h / 2 - m.fit.y;
            e.z = 0;
        });
    }

    return kiri.render.path(output, (progress, layer) => {
        update(0.5 + progress * 0.5, "render", layer);
    }, { thin: true, z: 0, action: "cut", moves: process.knifeOn });
};

function exportLaser(print, online, ondone) {
    ondone(print.output);
}

/**
 *
 */
function exportElements(settings, output, onpre, onpoly, onpost, onpoint, onlayer) {
    let process = settings.process,
        zcolor = process.outputLaserZColor,
        last,
        point,
        poly = [],
        min = {x:0, y:0},
        max = {x:0, y:0};

    output.forEach(function(layer) {
        layer.forEach(function(out) {
            point = out.point;
            if (process.outputInvertX) point.x = -point.x;
            if (process.outputInvertY) point.y = -point.y;
            min.x = Math.min(min.x, point.x);
            max.x = Math.max(max.x, point.x);
            min.y = Math.min(min.y, point.y);
            max.y = Math.max(max.y, point.y);
        });
    });

    if (!process.outputOriginCenter) {
        // normalize against origin lower left
        output.forEach(function(layer) {
            layer.forEach(function(out) {
                point = out.point;
                point.x -= min.x;
                point.y -= min.y;
            });
        });
        max.x = max.x - min.x;
        max.y = max.y - min.y;
        min.x = 0;
        min.y = 0;
    } else {
        // normalize against center of build area
        let w = settings.device.bedWidth;
        let h = settings.device.bedDepth;
        output.forEach(function(layer) {
            layer.forEach(function(out) {
                point = out.point;
                point.x += w/2;
                point.y += h/2;
            });
        });
        max.x = w;
        max.y = h;
        min.x = 0;
        min.y = 0;
    }

    onpre(min, max, process.outputLaserPower, process.outputLaserSpeed);

    output.forEach(function(layer, index) {
        let thick = 0;
        let color = 0;
        layer.forEach(function(out, li) {
            thick = out.thick;
            point = out.point;
            if (onlayer) {
                onlayer(index, point.z, out.thick, output.length);
            }
            if (out.emit) {
                color = out.emit;
                if (last && poly.length === 0) {
                    poly.push(onpoint(last));
                }
                poly.push(onpoint(point));
            } else if (poly.length > 0) {
                onpoly(poly, color, thick);
                poly = [];
            }
            last = point;
        });
        if (poly.length > 0) {
            onpoly(poly, color, thick);
            poly = [];
        }
    });

    onpost();
};

/**
 *
 */
function exportGCode(settings, data) {
    let lines = [], dx = 0, dy = 0, z = 0, feedrate;
    let dev = settings.device;
    let proc = settings.process;
    let space = dev.gcodeSpace ? ' ' : '';
    let power = 255;
    let laser_on = dev.gcodeLaserOn || [];
    let laser_off = dev.gcodeLaserOff || [];
    let knifeOn = proc.knifeOn;
    let knifeDepth = proc.outputKnifeDepth;
    let passes = knifeOn ? proc.outputKnifePasses : 1;

    exportElements(
        settings,
        data,
        function(min, max, power, speed) {
            let width = (max.x - min.x),
                height = (max.y - min.y);

            dx = min.x;
            dy = min.y;
            feedrate = `${space}F${speed}`;
            power = (256 * (power / 100)).toFixed(3);

            (dev.gcodePre || []).forEach(line => {
                lines.push(line);
            });
        },
        function(poly, color, thick) {
            if (knifeOn) {
                lines.push(`; start new poly id=${poly.id} len=${poly.length}`);
            }
            for (let i=1; i<passes + 1; i++) {
                poly.forEach(function(point, index) {
                    if (index === 0) {
                        if (knifeOn) {
                            // lift
                            lines.appendAll(['; drag-knife lift', `G0${space}Z5`]);
                        }
                        lines.push(`G0${space}${point}`);
                        if (knifeOn) {
                            // drop
                            lines.appendAll(['; drag-knife down', `G0${space}Z${-i * knifeDepth}`]);
                        }
                    } else if (index === 1) {
                        laser_on.forEach(line => {
                            line = line.replace('{power}', power);
                            line = line.replace('{color}', color);
                            line = line.replace('{thick}', thick);
                            line = line.replace('{z}', z);
                            lines.push(line);
                        });
                        lines.push(`G1${space}${point}${feedrate}`);
                    } else {
                        lines.push(`G1${space}${point}`);
                    }
                });
                laser_off.forEach(line => {
                    lines.push(line);
                });
            }
            if (knifeOn) {
                lines.appendAll([`G0${space}Z5`]);
            }
        },
        function() {
            (dev.gcodePost || []).forEach(line => {
                lines.push(line);
            });
        },
        function(point) {
            z = point.z;
            return `X${(point.x - dx).toFixed(3)}${space}Y${(point.y - dy).toFixed(3)}`;
        },
        function(layer, z, thick, layers) {
            // ununsed
        }
    );

    return lines.join('\n');
};

/**
 *
 */
function exportSVG(settings, data, cut_color) {
    let { process } = settings;
    let zcolor = process.outputLaserZColor ? 1 : 0;
    let zstack = process.outputLaserStack;
    let lines = [], dx = 0, dy = 0, my, z = 0;
    let colors = [
        "black",
        "purple",
        "blue",
        "red",
        "orange",
        "yellow",
        "green",
        "brown",
        "gray"
    ];

    exportElements(
        settings,
        data,
        function(min, max) {
            let width = (max.x - min.x),
                height = (max.y - min.y);
            dx = min.x;
            dy = min.y;
            my = max.y;
            lines.push('<?xml version="1.0" standalone="no"?>');
            lines.push('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">');
            lines.push(`<svg width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" version="1.1">`);
        },
        function(poly, color, thick) {
            let cout = zcolor || colors[((color-1) % colors.length)];
            let def = ["polyline"];
            if (z !== undefined) def.push(`z="${z}"`);
            if (thick !== undefined) def.push(`h="${thick}"`);
            lines.push(`<${def.join(' ')} points="${poly.join(' ')}" fill="none" stroke="${cout}" stroke-width="0.1mm" />`);
        },
        function() {
            lines.push("</svg>");
        },
        function(point) {
            z = point.z;
            return base.util.round(point.x - dx, 3) + "," + base.util.round(my - point.y - dy, 3);
        },
        function(layer, z, thick, layers) {
            if (zcolor) {
                zcolor = Math.round(((layer + 1) / layers) * 0xffffff).toString(16);
                zcolor = `#${zcolor.padStart(6,0)}`;
            }
        }
    );

    return lines.join('\n');
};

/**
 *
 */
function exportDXF(settings, data) {
    let lines = [];

    exportElements(
        settings,
        data,
        function(min, max) {
            lines.appendAll([
                '  0',
                'SECTION',
                '  2',
                'HEADER',
                '  9',
                '$ACADVER',
                '1',
                'AC1014',
                '  0',
                'ENDSEC',
                '  0',
                'SECTION',
                '  2',
                'ENTITIES',
            ]);
        },
        function(poly) {
            lines.appendAll([
                '  0',
                'LWPOLYLINE',
                '100', // subgroup required
                'AcDbPolyline',
                ' 90', // poly vertices
                poly.length,
                ' 70', // open
                '0',
                ' 43', // constant width line
                '0.0'
            ]);

            poly.forEach(function(point) {
                lines.appendAll([
                    ' 10',
                    point.x,
                    ' 20',
                    point.y
                ]);
            });

            lines.appendAll([
                '  0',
                'SEQEND',
            ]);
        },
        function() {
            lines.appendAll([
                '  0',
                'ENDSEC',
                '  0',
                'EOF',
            ]);
        },
        function(point) {
            return {x:point.x,y:point.y};
        }
    );

    return lines.join('\n');
};

});

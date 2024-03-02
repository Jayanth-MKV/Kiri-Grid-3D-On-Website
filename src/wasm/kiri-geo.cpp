//#define use_int32

#include <emscripten.h>
#include "clipper.hpp"

typedef unsigned char Uint8;
typedef unsigned short Uint16;
typedef unsigned int Uint32;
typedef int int32;

using namespace ClipperLib;

Uint8 *mem = 0;

extern "C" {
    extern void debug_string(Uint32 len, char *str);
}

struct length16 {
    Uint16 length;
};

struct point32 {
    int32 x;
    int32 y;
};

__attribute__ ((export_name("mem_get")))
Uint32 mem_get(Uint32 size) {
    return (Uint32)malloc(size);
}

__attribute__ ((export_name("mem_clr")))
void mem_clr(Uint32 loc) {
    free((void *)loc);
}

void send_string(const char *format, ...) {
    char buffer[100];
    va_list args;
    va_start(args, format);
    Uint32 len =  vsprintf(buffer, format, args);
    va_end(args);
    debug_string(len, buffer);
}

Uint32 readPoly(Path &path, Uint32 pos) {
    struct length16 *ls = (struct length16 *)(mem + pos);
    Uint16 points = ls->length;
    pos += 2;
    while (points > 0) {
        struct point32 *ip = (struct point32 *)(mem + pos);
        pos += 8;
        path << IntPoint(ip->x, ip->y);
        points--;
    }
    return pos;
}

Uint32 readPolys(Paths &paths, Uint32 pos, Uint32 count) {
    Uint32 poly = 0;
    while (count > 0) {
        pos = readPoly(paths[poly++], pos);
        count--;
    }
    return pos;
}

Uint32 writePolys(Paths &outs, Uint32 pos) {
    for (Path po : outs) {
        struct length16 *ls = (struct length16 *)(mem + pos);
        ls->length = po.size();
        pos += 2;
        for (IntPoint pt : po) {
            struct point32 *ip = (struct point32 *)(mem + pos);
            ip->x = (int)pt.X;
            ip->y = (int)pt.Y;
            pos += 8;
        }
    }
    // null terminate
    struct length16 *ls = (struct length16 *)(mem + pos);
    ls->length = 0;
    return pos + 2;
}

__attribute__ ((export_name("poly_offset")))
Uint32 poly_offset(Uint32 memat, Uint32 polys, float offset, float clean, Uint8 simple) {
    Paths ins(polys);
    Paths outs;
    Uint32 pos = memat;
    Uint16 poly = 0;

    pos = readPolys(ins, pos, polys);

    if (clean > 0) {
        Paths cleans;
        CleanPolygons(ins, cleans, clean);
        ins = cleans;
    }

    if (simple > 0) {
        Paths simples;
        SimplifyPolygons(ins, simples);
        ins = simples;
    }

    ClipperOffset co;
    co.AddPaths(ins, jtMiter, etClosedPolygon);
    co.Execute(outs, offset);

    Uint32 resat = pos;

    pos = writePolys(outs, pos);

    co.Clear();

    return resat;
}

__attribute__ ((export_name("poly_union")))
Uint32 poly_union(Uint32 memat, Uint32 polys, float offset) {

    Paths ins(polys);
    Paths outs;
    Uint32 pos = memat;
    Uint16 poly = 0;

    pos = readPolys(ins, pos, polys);

    Clipper clip;
    clip.AddPaths(ins, ptSubject, true);
    clip.Execute(ctUnion, outs);

    Uint32 resat = pos;

    pos = writePolys(outs, pos);

    clip.Clear();

    return resat;
}

__attribute__ ((export_name("poly_diff")))
Uint32 poly_diff(Uint32 memat, Uint32 polysA, Uint32 polysB, Uint8 AB, Uint8 BA, float clean) {

    Paths inA(polysA);
    Paths inB(polysB);
    Uint32 pos = memat;

    pos = readPolys(inA, pos, polysA);
    pos = readPolys(inB, pos, polysB);

    Uint32 resat = pos;

    if (AB > 0) {
        Paths outs;
        Clipper clip;
        clip.AddPaths(inA, ptSubject, true);
        clip.AddPaths(inB, ptClip, true);
        clip.Execute(ctDifference, outs, pftEvenOdd, pftEvenOdd);
        if (clean > 0) {
            // CleanPolygons(outs, clean);
            for (Path po : outs) {
                CleanPolygon(po, clean);
            }
        }
        pos = writePolys(outs, pos);
        clip.Clear();
    }

    if (BA > 0) {
        Paths outs;
        Clipper clip;
        clip.AddPaths(inB, ptSubject, true);
        clip.AddPaths(inA, ptClip, true);
        clip.Execute(ctDifference, outs, pftEvenOdd, pftEvenOdd);
        if (clean > 0) {
            // CleanPolygons(outs, clean);
            for (Path po : outs) {
                CleanPolygon(po, clean);
            }
        }
        pos = writePolys(outs, pos);
        clip.Clear();
    }

    return resat;
}

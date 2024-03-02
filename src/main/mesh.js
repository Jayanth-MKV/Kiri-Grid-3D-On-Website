/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

// dep: moto.license
// dep: moto.webui
// dep: moto.client
// dep: moto.broker
// dep: moto.space
// dep: data.index
// dep: mesh.api
// dep: mesh.model
// dep: mesh.build
// dep: load.file
// use: geo.polygons
gapp.main("main.mesh", [], (root) => {

const { Quaternion, Mesh, MeshPhongMaterial, PlaneGeometry, DoubleSide, Vector3 } = THREE;
const { broker } = gapp;
const { moto } = root;
const { space } = moto;

const version = '1.3.0';
const call = broker.send;
const dbindex = [ "admin", "space" ];

// set below. called once the DOM readyState = complete
// this is the main() entrypoint called after all dependents load
function init() {
    let stores = data.open('mesh', { stores: dbindex, version: 4 }).init(),
        dark = false,
        ortho = false,
        zoomrev = true,
        zoomspd = 1,
        platform = space.platform,
        db = mesh.db = {
            admin: stores.promise('admin'),
            space: stores.promise('space')
        };

    // mark init time and use count
    db.admin.put("init", Date.now());
    db.admin.get("uses").then(v => db.admin.put("uses", (v||0) + 1));

    // setup default workspace
    space.setAntiAlias(true);
    space.useDefaultKeys(false);
    space.init($('container'), delta => { }, ortho);
    space.sky.set({
        grid: false,
        color: dark ? 0 : 0xffffff
    });
    platform.set({
        volume: false,
        round: false,
        zOffset: 0,
        opacity: 0,
        color: 0xdddddd,
        zoom: { reverse: true, speed: 1 },
        size: { width: 2000, depth: 2000, height: 0.05, maxz: 2000 },
        grid: { major: 25, minor: 5, zOffset: 0,
            colorMajor: 0xcccccc, colorMinor: 0xeeeeee,
            colorX: 0xff7777, colorY: 0x7777ff },
    });
    platform.onMove(() => {
        // save last location and focus
        db.admin.put('camera', {
            place: space.view.save(),
            focus: space.view.getFocus()
        });
    }, 100);
    space.view.setZoom(zoomrev, zoomspd);

    // reload stored space when worker is ready
    moto.client.on('ready', restore_space);

    // start worker
    moto.client.start(`/code/mesh_work?${gapp.version}`);

    // trigger space event binding
    call.space_init({ space, platform });

    // trigger ui building
    call.ui_build();
}

// restore space layout and view from previous session
async function restore_space() {
    const { api } = mesh;
    const space = moto.space;
    const db_admin = mesh.db.admin;
    const db_space = mesh.db.space;
    // let mcache = {};
    await db_admin.get("camera")
        .then(saved => {
            if (saved) {
                space.view.load(saved.place);
                space.view.setFocus(saved.focus);
            }
        });
    const mcache = await db_admin.get("matrices") || {};
    let count = 0;
    await db_space.iterate({ map: true }).then(cached => {
        const keys = [];
        const claimed = [];
        for (let [id, data] of Object.entries(cached)) {
            keys.push(id);
            if (count++ === 0) {
                mesh.api.log.emit(`restoring workspace`);
            }
            // restore group
            if (Array.isArray(data)) {
                claimed.push(id);
                let models = data
                    .map(id => {
                        claimed.push(id);
                        return { id, md: cached[id] }
                    })
                    .filter(r => r.md) // filter cache misses
                    .map(r => new mesh.model(r.md, r.id).applyMatrix(mcache[r.id]));
                if (models.length) {
                    mesh.api.log.emit(`restored ${models.length} model(s)`);
                    mesh.api.group.new(models, id).applyMatrix(mcache[id]);
                } else {
                    mesh.api.log.emit(`removed empty group ${id}`);
                    db_space.remove(id);
                }
            }
        }
        for (let id of claimed) {
            keys.remove(id);
        }
        if (keys.length) {
            mesh.api.log.emit(`removing ${keys.length} unclaimed meshes`);
        }
        // clear out meshes left in the space db along with their matrices
        for (let id of keys) {
            db_space.remove(id);
            delete mcache[id];
        }
        // restore global cache only after objects are restored
        // otherwise their setup will corrupt the cache for other restores
        matrixCache = mcache;
        store_matrices();
    }).then(() => {
        // restore preferences after models are restored
        return api.prefs.load().then(() => {
            let { map } = api.prefs;
            let { space, mode } = map;
            api.grid(space.grid);
            // restore selected state
            let selist = space.select || [];
            let smodel = api.model.list().filter(m => selist.contains(m.id));
            let sgroup = api.group.list().filter(m => selist.contains(m.id));
            let tolist = space.tools || [];
            let tmodel = api.model.list().filter(m => tolist.contains(m.id));
            let tgroup = api.group.list().filter(m => tolist.contains(m.id));
            api.selection.set([...smodel, ...sgroup], [...tmodel, ...tgroup]);
            // restore edit mode
            api.mode.set(mode);
            // restore dark mode
            set_darkmode(map.space.dark);
        });
    }).finally(() => {
        // hide loading curtain
        $d('curtain','none');
        if (api.prefs.map.info.welcome !== false) {
            api.welcome(version);
        }
    });
}

// toggle edit/split temporary mode (present plane on hover)
let temp_mode;

// split functions
let split = {
    start() {
        let space = moto.space;
        let { api, util } = mesh;
        // highlight button
        let button = event.target;
        button.classList.add('selected');
        // create split plane visual
        let geo, mat, obj = new Mesh(
            geo = new PlaneGeometry(1,1),
            mat = new MeshPhongMaterial({
                side: DoubleSide,
                color: 0x5555aa,
                transparent: false,
                opacity: 0.5
            })
        );
        space.scene.add(obj);
        // hide until first hover
        obj.visible = false;
        // enable temp mode
        let state = split.state = { button, obj };
        let models = state.models = api.selection.models();
        let meshes = models.map(m => m.mesh);
        // for split and lay flat modes
        space.mouse.onHover((int, event, ints) => {
            if (!event) {
                return meshes;
            }
            obj.visible = false;
            let { button, buttons } = event;
            if (buttons) {
                return;
            }
            let { dim, mid } = util.bounds(meshes);
            let { point, face, object } = int;
            let { x, y, z } = point;

            mat.color.set(0x5555aa);
            obj.visible = true;
            if (event.shiftKey) {
                y = split.closestZ(y, object, face).y;
            }
            // y is z in model space for the purposes of a split
            state.plane = { z: y };
            obj.scale.set(dim.x + 2, dim.y + 2, 1);
            obj.position.set(mid.x, y, -mid.y);
        });
        temp_mode = split;
    },

    select() {
        let { log } = mesh.api;
        let { models, plane } = split.state;
        log.emit(`splitting ${models.length} model(s) at ${plane.z.round(3)}`).pin();
        Promise.all(models.map(m => m.split(plane))).then(models => {
            mesh.api.selection.set(models);
            log.emit('split complete').unpin();
            split.end();
        });
    },

    end() {
        let space = moto.space;
        let { button, obj } = split.state;
        button.classList.remove('selected');
        space.scene.remove(obj);
        space.mouse.onHover(undefined);
        temp_mode = split.state = undefined;
        mesh.api.selection.update();
    },

    closestZ(z, object, face) {
        let { position } = object.geometry.attributes;
        let matrix = object.matrixWorld;
        let v0 = new Vector3(position.getX(face.a), position.getY(face.a), position.getZ(face.a)).applyMatrix4(matrix);
        let v1 = new Vector3(position.getX(face.b), position.getY(face.b), position.getZ(face.b)).applyMatrix4(matrix);
        let v2 = new Vector3(position.getX(face.c), position.getY(face.c), position.getZ(face.c)).applyMatrix4(matrix);
        v0._d = Math.abs(v0.y - z);
        v1._d = Math.abs(v1.y - z);
        v2._d = Math.abs(v2.y - z);
        return [ v0, v1, v2 ].sort((a,b) => a._d - b._d)[0];
    }
}

function edit_split(event) {
    if (temp_mode) {
        temp_mode.end();
    } else {
        split.start();
    }
}

// add space event bindings
function space_init(data) {
    let { space, platform } = data;
    let platcolor = 0x00ff00;
    let api = mesh.api;
    let { selection } = api;

    // add file drop handler
    space.event.addHandlers(self, [
        'drop', (evt) => {
            estop(evt);
            platform.set({ opacity: 0, color: platcolor });
            call.load_files([...evt.dataTransfer.files]);
        },
        'dragover', evt => {
            estop(evt);
            evt.dataTransfer.dropEffect = 'copy';
            let color = platform.setColor(0x00ff00);
            if (color !== 0x00ff00) platcolor = color;
            platform.set({ opacity: 0.1 });
        },
        'dragleave', evt => {
            platform.set({ opacity: 0, color: platcolor });
        },
        'keypress', evt => {
            if (api.modal.showing) {
                return;
            }
            if (evt.key === '?') {
                return api.welcome(version);
            }
            let { shiftKey, metaKey, ctrlKey, code } = evt;
            switch (code) {
                case 'KeyQ':
                    return api.settings();
                case 'KeyI':
                    return api.file.import();
                case 'KeyX':
                    return api.file.export();
                case 'KeyD':
                    return shiftKey && api.tool.duplicate();
                case 'KeyC':
                    return selection.centerXY().focus();
                case 'KeyF':
                    return selection.floor().focus();
                case 'KeyM':
                    return shiftKey ? api.tool.merge() : api.tool.mirror();
                case 'KeyU':
                    return shiftKey && api.tool.union();
                case 'KeyA':
                    return shiftKey && api.tool.analyze();
                case 'KeyR':
                    return shiftKey ? api.tool.rebuild() : api.tool.repair();
                case 'KeyE':
                    return api.tool.clean();
                case 'KeyV':
                    return selection.focus();
                case 'KeyN':
                    return shiftKey ? estop(evt, api.tool.rename()) : api.normals();
                case 'KeyW':
                    return api.wireframe();
                case 'KeyG':
                    return shiftKey ? api.tool.regroup() : api.grid();
                case 'KeyL':
                    return api.log.toggle({ spinner: false });
                case 'KeyS':
                    return shiftKey ? selection.visible({toggle:true}) : call.edit_split();
                case 'KeyB':
                    return selection.boundsBox({toggle:true});
                case 'KeyH':
                    return space.view.home();
                case 'KeyT':
                    return space.view.top();
                case 'KeyZ':
                    return space.view.reset();
            }
        },
        'keydown', evt => {
            let { shiftKey, metaKey, ctrlKey, code } = evt;
            let rv = (Math.PI / 12);
            if (api.modal.showing) {
                if (code === 'Escape') {
                    api.modal.cancel();
                }
                return;
            }
            let rot, floor = api.prefs.map.space.floor !== false;
            switch (code) {
                case 'KeyA':
                    if (metaKey || ctrlKey) {
                        selection.set(api.group.list());
                        estop(evt);
                    }
                    break;
                case 'Escape':
                    selection.clear();
                    temp_mode && temp_mode.end();
                    estop(evt);
                    break;
                case 'Backspace':
                case 'Delete':
                    let mode = api.mode.get();
                    if ([api.modes.object, api.modes.tool].contains(mode)) {
                        selection.delete();
                    } else {
                        for (let m of selection.models()) {
                            m.deleteSelections(mode);
                            space.refresh()
                        }
                    }
                    estop(evt);
                    break;
                case 'ArrowUp':
                    rot = selection.rotate(-rv,0,0);
                    break;
                case 'ArrowDown':
                    rot = selection.rotate(rv,0,0);
                    break;
                case 'ArrowLeft':
                    if (shiftKey) {
                        rot = selection.rotate(0,-rv,0);
                    } else {
                        floor = false;
                        rot = selection.rotate(0,0,rv);
                    }
                    break;
                case 'ArrowRight':
                    if (shiftKey) {
                        rot = selection.rotate(0,rv,0);
                    } else {
                        floor = false;
                        rot = selection.rotate(0,0,-rv);
                    }
                    break;
            }
            if (rot && floor) {
                // todo future pref to auto-floor or not
                rot.floor(mesh.group);
            }
        }
    ]);

    // mouse hover/click handlers. required to enable model drag in space.js
    space.mouse.downSelect((int, event) => {
        return event && event.shiftKey ? api.objects() : undefined;
    });

    space.mouse.upSelect((int, event) => {
        if (event && event.target.nodeName === "CANVAS") {
            const model = int && int.object.model ? int.object.model : undefined;
            if (temp_mode) {
                return temp_mode.select(model);
            }
            if (model) {
                const group = model.group;
                const { altKey, ctrlKey, metaKey, shiftKey } = event;
                if (metaKey) {
                    // set focus on intersected face
                    const { x, y, z } = int.point;
                    const q = new Quaternion().setFromRotationMatrix(group.object.matrix);
                    // rotate normal using group's matrix
                    const normal = shiftKey ? int.face.normal.applyQuaternion(q) : undefined;
                    // y,z swap due to world rotation for orbit controls
                    api.focus({center: { x, y:-z, z:y }, normal});
                } else if (ctrlKey) {
                    // rotate selected face towawrd z "floor"
                    group.faceDown(int.face.normal);
                    selection.update();
                } else {
                    const { modes } = api;
                    const { surface } = api.prefs.map;
                    const opt = { radians: 0, radius: surface.radius };
                    const mode = api.mode.get();
                    switch(mode) {
                        case modes.object:
                        case modes.tool:
                            selection.toggle(shiftKey ? model : model.group, mode === modes.tool);
                            break;
                        case modes.surface:
                            opt.radians = surface.radians;
                        case modes.face:
                            // find faces adjacent to point/line clicked
                            model.find(int,
                                altKey ? { toggle: true } :
                                shiftKey ? { clear: true } : { select: true },
                                opt);
                            break;
                    }
                }
            }
        } else {
            return api.objects().filter(o => o.visible);
        }
    });

    space.mouse.onDrag((delta, offset, up = false) => {
        const { mode, modes } = api;
        if (delta && delta.event.shiftKey) {
            selection.move(delta.x, delta.y, 0);
        } else if (mode.is([ modes.object, modes.tool ])) {
            return api.objects().length > 0;
        }
    });
}

function load_files(files) {
    mesh.api.log.emit(`loading file...`);
    let api = mesh.api;
    let has_image = false;
    let has_svg = false;
    for (let file of files) {
        has_image = has_image || file.type === 'image/png';
        has_svg = has_svg || file.name.toLowerCase().indexOf(".svg") > 0;
    }
    if (has_svg) {
        api.modal.dialog({
            title: `svg import`,
            body: [ h.div({ class: "image-import" }, [
                h.div([
                    h.label("extrude"),
                    h.input({ id: "extrude_height", value: 5, size: 4 })
                ]),
                h.div([
                    h.label("repair"),
                    h.input({ id: "svg_repair", type: "checkbox", checked: true })
                ]),
                h.div([
                    h.button({ _: "import", onclick() {
                        let { svg_repair, extrude_height } = api.modal.bound;
                        load_files_opt(files, {
                            soup: svg_repair.checked,
                            depth: extrude_height
                        });
                        api.modal.hide();
                    } }),
                ])
            ]) ]
        });
    } else if (has_image) {
        api.modal.dialog({
            title: `image import`,
            body: [ h.div({ class: "image-import" }, [
                h.div([
                    h.label("invert pixels"),
                    h.input({ id: "inv_image", type: "checkbox" })
                ]),
                h.div([
                    h.label("invert alpha"),
                    h.input({ id: "inv_alpha", type: "checkbox" })
                ]),
                h.div([
                    h.label("border size"),
                    h.input({ id: "img_border", value: 0, size: 4 })
                ]),
                h.div([
                    h.label("blur pixels"),
                    h.input({ id: "img_blur", value: 0, size: 4 })
                ]),
                h.div([
                    h.label("base pixels"),
                    h.input({ id: "img_base", value: 0, size: 4 })
                ]),
                h.div([
                    h.button({ _: "import", onclick() {
                        let { inv_image, inv_alpha, img_border, img_blur, img_base } = api.modal.bound;
                        load_files_opt(files, {
                            inv_image: inv_image.checked,
                            inv_alpha: inv_alpha.checked,
                            border: parseInt(img_border.value || 0),
                            blur: parseInt(img_blur.value || 0),
                            base: parseInt(img_base.value || 0),
                        });
                        api.modal.hide();
                    } }),
                ])
            ]) ]
        });
    } else {
        load_files_opt(files);
    }
}

function load_files_opt(files, opt) {
    load.File.load([...files], opt)
        .then(data => {
            call.space_load(data);
        })
        .catch(error => {
            dbug.error(error);
        })
        .finally(() => {
            mesh.api.log.hide();
        });
}

// add object loader
function space_load(data) {
    if (data && data.length && (data = data.flat()).length)
    mesh.api.group.new(data.map(el => new mesh.model(el)))
        .promote()
        .focus();
}

let matrixCache = {};

// todo deferred with util
function store_matrices() {
    mesh.db.admin.put("matrices", matrixCache);
}

// cache model matrices for page restores
function object_matrix(data) {
    let { id, matrix } = data;
    matrixCache[id] = matrix.elements;
    store_matrices();
}

function object_destroy(id) {
    delete matrixCache[id];
    store_matrices();
}

// listen for changes like dark mode toggle
function set_darkmode(dark) {
    let { prefs, selection, model } = mesh.api;
    let { sky, platform } = moto.space;
    prefs.map.space.dark = dark;
    if (dark) {
        mesh.material.wireframe.color.set(0xaaaaaa);
        $('app').classList.add('dark');
    } else {
        mesh.material.wireframe.color.set(0,0,0);
        $('app').classList.remove('dark');
    }
    sky.set({
        color: dark ? 0 : 0xffffff,
        ambient: { intensity: dark ? 0.55 : 1.1 }
    });
    platform.set({
        light: dark ? 0.08 : 0.08,
        grid: dark ? {
            colorMajor: 0x666666,
            colorMinor: 0x333333,
        } : {
            colorMajor: 0xcccccc,
            colorMinor: 0xeeeeee,
        },
    });
    mesh.api.updateFog();
    platform.setSize();
    for (let m of model.list()) {
        m.normals({ refresh: true });
    }
    prefs.save();
}

function set_normals_length(length) {
    let { prefs } = mesh.api;
    prefs.map.normals.length = length || 1;
    prefs.save();
}

function set_normals_color(color) {
    let { prefs } = mesh.api;
    let { map } = prefs;
    if (map.space.dark) {
        map.normals.color_dark = color || 0;
    } else {
        map.normals.color_lite = color || 0;
    }
    prefs.save();
}

function set_surface_radians(radians) {
    let { prefs } = mesh.api;
    prefs.map.surface.radians = parseFloat(radians || 0.1);
    prefs.save();
}

function set_surface_radius(radius) {
    let { prefs } = mesh.api;
    prefs.map.surface.radius = parseFloat(radius || 0.2);
    prefs.save();
}

function set_wireframe_opacity(opacity) {
    let { prefs } = mesh.api;
    prefs.map.wireframe.opacity = parseFloat(opacity || 0.15);
    prefs.save();
}

function set_wireframe_fog(fogx) {
    let { prefs } = mesh.api;
    prefs.map.wireframe.fog = parseFloat(fogx || 3);
    prefs.save();
}

// bind functions to topics
broker.listeners({
    edit_split,
    load_files,
    object_matrix,
    object_destroy,
    space_init,
    space_load,
    set_darkmode,
    set_normals_color,
    set_normals_length,
    set_surface_radians,
    set_surface_radius,
    set_wireframe_opacity,
    set_wireframe_fog
});

// remove version cache bust from url
window.history.replaceState({},'','/mesh/');

// setup init() trigger when dom + scripts complete
document.onreadystatechange = function() {
    if (document.readyState === 'complete') {
        init();
    }
}

});

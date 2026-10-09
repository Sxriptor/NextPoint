import * as THREE from 'three';

const flat = (color) => new THREE.MeshLambertMaterial({ color, flatShading: true });
const UP = new THREE.Vector3(0, 1, 0);
const UPPER = 0.3, FORE = 0.3;

// Points a Y-axis box from A to B.
function placeSegment(mesh, a, b) {
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(b, a);
  mesh.scale.y = dir.length();
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
}

// Two-bone IK: shoulder S reaching target T, elbow bent toward `pole`. Writes elbow & hand.
function solveArm(S, T, pole, elbow, hand) {
  const d = new THREE.Vector3().subVectors(T, S);
  const dist = Math.min(Math.max(d.length(), 0.05), UPPER + FORE - 0.001);
  d.normalize();
  const a = (UPPER * UPPER - FORE * FORE + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, UPPER * UPPER - a * a));
  const bend = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
  elbow.copy(S).addScaledVector(d, a).addScaledVector(bend, h);
  hand.copy(S).addScaledVector(d, dist);
}

// Low-poly seated person. Built relative to a seat origin (floor under the seat), facing +z.
export function createCharacter({ shirt, skin = 0xe0b48a, pants = 0x2f3442, hair = 0x3a2a1c }) {
  const group = new THREE.Group();
  const shirtM = flat(shirt), skinM = flat(skin), pantsM = flat(pants), hairM = flat(hair), darkM = flat(0x1a1a1a);
  const add = (geo, m, parent = group) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  const torso = add(new THREE.BoxGeometry(0.42, 0.52, 0.24), shirtM);
  torso.position.set(0, 0.9, -0.12);
  torso.rotation.x = -0.12;
  add(new THREE.BoxGeometry(0.1, 0.08, 0.1), skinM).position.set(0, 1.19, -0.1);

  const head = new THREE.Group();
  head.position.set(0, 1.22, -0.08);
  head.rotation.order = 'YXZ';
  group.add(head);
  add(new THREE.BoxGeometry(0.24, 0.28, 0.26), skinM, head).position.y = 0.13;
  add(new THREE.BoxGeometry(0.26, 0.08, 0.28), hairM, head).position.y = 0.29;
  add(new THREE.BoxGeometry(0.26, 0.18, 0.06), hairM, head).position.set(0, 0.2, -0.13);
  for (const x of [0.06, -0.06]) add(new THREE.BoxGeometry(0.04, 0.04, 0.02), darkM, head).position.set(x, 0.16, 0.13);
  const mouth = add(new THREE.BoxGeometry(0.08, 0.02, 0.02), flat(0x8a3b30), head);
  mouth.position.set(0, 0.06, 0.13);
  const blindfold = add(new THREE.BoxGeometry(0.27, 0.07, 0.28), darkM, head);
  blindfold.position.y = 0.16;
  blindfold.visible = false;

  // Legs (static, seated)
  for (const x of [0.11, -0.11]) {
    const hip = new THREE.Vector3(x, 0.64, -0.05), knee = new THREE.Vector3(x * 1.1, 0.7, 0.38), foot = new THREE.Vector3(x * 1.1, 0.46, 0.6);
    placeSegment(add(new THREE.BoxGeometry(0.15, 1, 0.15), pantsM), hip, knee);
    placeSegment(add(new THREE.BoxGeometry(0.12, 1, 0.12), pantsM), knee, foot);
    add(new THREE.BoxGeometry(0.12, 0.08, 0.22), darkM).position.set(foot.x, 0.44, foot.z + 0.06);
  }

  // Arms: index 0 = left (+x), 1 = right
  const arms = [0.25, -0.25].map((x) => ({
    shoulder: new THREE.Vector3(x, 1.1, -0.1),
    pole: new THREE.Vector3(Math.sign(x) * 0.6, -1, -0.3),
    upper: add(new THREE.BoxGeometry(0.1, 1, 0.1), shirtM),
    fore: add(new THREE.BoxGeometry(0.085, 1, 0.085), skinM),
    hand: add(new THREE.BoxGeometry(0.08, 0.06, 0.1), skinM),
    elbow: new THREE.Vector3(),
    wrist: new THREE.Vector3(),
  }));

  return {
    group,
    head,
    // yaw: + looks left. pitch: + looks up.
    setHead(yaw, pitch) {
      head.rotation.y = yaw * 0.9;
      head.rotation.x = -pitch * 0.8;
    },
    // Targets are in this character's local space.
    setHands(left, right) {
      [left, right].forEach((target, i) => {
        const arm = arms[i];
        solveArm(arm.shoulder, target, arm.pole, arm.elbow, arm.wrist);
        placeSegment(arm.upper, arm.shoulder, arm.elbow);
        placeSegment(arm.fore, arm.elbow, arm.wrist);
        arm.hand.position.copy(arm.wrist);
        arm.hand.quaternion.copy(arm.fore.quaternion);
      });
    },
    setTalking(level) {
      mouth.scale.y = 1 + Math.min(1, level * 10) * 3;
    },
    setBlindfold(on) {
      blindfold.visible = on;
    },
    // Hide your own head so the camera (which sits inside it) sees out.
    setFirstPerson(on) {
      head.visible = !on;
    },
  };
}

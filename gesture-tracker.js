const VISION_VERSION = '0.10.22';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const GESTURES = {
  '00000': 'Closed fist',
  '11111': 'Open palm',
  '10000': 'Thumbs up',
  '01100': 'Peace sign',
  '01000': 'Pointing',
  '01110': 'Three fingers'
};

function fingerState(landmarks, handedness) {
  const wrist = landmarks[0];
  const fingers = [
    Math.abs(landmarks[4].x - landmarks[2].x) > Math.abs(landmarks[3].x - landmarks[2].x) * 1.15,
    landmarks[8].y < landmarks[6].y,
    landmarks[12].y < landmarks[10].y,
    landmarks[16].y < landmarks[14].y,
    landmarks[20].y < landmarks[18].y
  ];
  const handConfidence = handedness?.score ?? 0;
  const handVisible = Number.isFinite(wrist.x) && handConfidence >= 0.35;
  return { fingers: fingers.map(Number), confidence: handVisible ? handConfidence : 0 };
}

function identifyGesture(fingers) {
  const key = fingers.map((value) => value >= 0.58 ? '1' : '0').join('');
  return GESTURES[key] || `Custom ${fingers.filter((value) => value >= 0.58).length}-finger pose`;
}

export class GestureTracker {
  constructor(video, onUpdate) {
    this.video = video;
    this.onUpdate = onUpdate;
    this.stream = null;
    this.landmarker = null;
    this.frame = 0;
    this.running = false;
    this.lastVideoTime = -1;
    this.smoothed = [0, 0, 0, 0, 0];
    this.lastStable = '';
    this.stableFrames = 0;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access is not available in this browser or page context.');
    }

    const vision = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/+esm`);
    const files = await vision.FilesetResolver.forVisionTasks(WASM_URL);
    this.landmarker = await vision.HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55
    });

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.frame = requestAnimationFrame(() => this.detect());
  }

  detect() {
    if (!this.running || !this.landmarker || this.video.readyState < 2) {
      if (this.running) this.frame = requestAnimationFrame(() => this.detect());
      return;
    }

    if (this.video.currentTime !== this.lastVideoTime) {
      const result = this.landmarker.detectForVideo(this.video, performance.now());
      this.lastVideoTime = this.video.currentTime;
      const landmarks = result.landmarks?.[0];
      if (!landmarks) {
        this.stableFrames = 0;
        this.lastStable = '';
        this.onUpdate({ tracking: false });
      } else {
        const detection = fingerState(landmarks, result.handednesses?.[0]?.[0]);
        detection.fingers.forEach((value, index) => {
          this.smoothed[index] = this.smoothed[index] * 0.72 + value * 0.28;
        });

        const gesture = identifyGesture(this.smoothed);
        if (gesture === this.lastStable) this.stableFrames += 1;
        else { this.lastStable = gesture; this.stableFrames = 1; }

        this.onUpdate({
          tracking: true,
          fingers: this.smoothed.map((value) => value >= 0.58),
          gesture: this.stableFrames >= 5 ? gesture : 'Stabilizing…',
          confidence: Math.round(detection.confidence * 100)
        });
      }
    }
    this.frame = requestAnimationFrame(() => this.detect());
  }

  async stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.onUpdate({ tracking: false, stopped: true });
  }
}

interface TurnIceServer {
  readonly urls: readonly string[];
  readonly username: string;
  readonly credential: string;
}

interface BrowserSession {
  readonly callId: string;
  readonly role: 'caller' | 'callee';
  readonly peerLabel: string;
  readonly turnCredentials: {
    readonly iceServers: readonly TurnIceServer[];
    readonly expiresAt: number;
  };
  readonly remoteOfferSdp?: string;
}

interface BrowserEventEnvelope {
  readonly sequence: number;
  readonly event:
    | Readonly<{
        kind: 'remote-description';
        description: Readonly<{ type: 'offer' | 'answer'; sdp: string }>;
      }>
    | Readonly<{ kind: 'ended'; reason: string }>;
}

const token = window.location.hash.slice(1);
window.history.replaceState(null, '', '/');

const localVideo = requireElement('local', HTMLVideoElement);
const remoteVideo = requireElement('remote', HTMLVideoElement);
const status = requireElement('status', HTMLDivElement);
const security = requireElement('security', HTMLDivElement);
const peer = requireElement('peer', HTMLDivElement);
const muteButton = requireElement('mute', HTMLButtonElement);
const cameraButton = requireElement('camera', HTMLButtonElement);
const hangupButton = requireElement('hangup', HTMLButtonElement);

let connection: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let pendingRemoteStream: MediaStream | null = null;
let lastEventSequence = 0;
let closed = false;
let routeVerified = false;
let routeVerificationStarted = false;
let wantsAudio = true;
let wantsVideo = true;

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Call setup failed';
  fail(message);
});

async function start(): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error('Local call authorization is missing');
  }
  const session = parseSession(await api('/api/session'));
  peer.textContent = `peer ${session.peerLabel}`;
  if (session.turnCredentials.expiresAt <= Date.now()) {
    throw new Error('TURN credentials expired before call setup');
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  for (const track of localStream.getTracks()) {
    track.enabled = false;
  }
  localVideo.srcObject = localStream;
  connection = new RTCPeerConnection({
    iceServers: session.turnCredentials.iceServers.map((server) => ({
      urls: [...server.urls],
      username: server.username,
      credential: server.credential,
    })),
    iceTransportPolicy: 'relay',
    bundlePolicy: 'max-bundle',
  });
  for (const track of localStream.getTracks()) {
    connection.addTrack(track, localStream);
  }
  connection.addEventListener('track', (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    pendingRemoteStream = stream;
    if (routeVerified) {
      remoteVideo.srcObject = stream;
    }
  });
  connection.addEventListener('connectionstatechange', () => {
    if (connection?.connectionState === 'connected') {
      void verifyRelayRoute(connection).catch((error: unknown) => {
        fail(
          error instanceof Error ? error.message : 'Relay verification failed',
        );
      });
    }
    if (connection?.connectionState === 'failed') {
      fail('Encrypted TURN connection failed');
    }
  });

  if (session.role === 'callee') {
    if (session.remoteOfferSdp === undefined) {
      throw new Error('Incoming call offer is missing');
    }
    assertRelayOnlySdp(session.remoteOfferSdp);
    await connection.setRemoteDescription({
      type: 'offer',
      sdp: session.remoteOfferSdp,
    });
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await waitForIceGathering(connection);
    await sendLocalDescription(connection, 'answer');
  } else {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection);
    await sendLocalDescription(connection, 'offer');
  }

  setStatus(session.role === 'caller' ? 'ringing…' : 'connecting…');
  void pollEvents();
}

muteButton.addEventListener('click', () => {
  wantsAudio = !wantsAudio;
  applyMediaPreferences();
  muteButton.textContent = wantsAudio ? 'mute' : 'unmute';
});

cameraButton.addEventListener('click', () => {
  wantsVideo = !wantsVideo;
  applyMediaPreferences();
  cameraButton.textContent = wantsVideo ? 'camera off' : 'camera on';
});

hangupButton.addEventListener('click', () => {
  void postCommand({ kind: 'hangup' }).finally(() => closeMedia('call ended'));
});

window.addEventListener('pagehide', () => {
  if (!closed) {
    void postCommand({ kind: 'hangup' });
  }
  closeMedia('call ended');
});

async function pollEvents(): Promise<void> {
  while (!closed) {
    try {
      const value = await api(`/api/events?after=${String(lastEventSequence)}`);
      for (const envelope of parseEvents(value)) {
        lastEventSequence = Math.max(lastEventSequence, envelope.sequence);
        if (envelope.event.kind === 'ended') {
          closeMedia(envelope.event.reason);
          return;
        }
        assertRelayOnlySdp(envelope.event.description.sdp);
        if (envelope.event.description.type !== 'answer') {
          throw new Error('Unexpected remote WebRTC description');
        }
        await connection?.setRemoteDescription(envelope.event.description);
        setStatus('connecting…');
      }
    } catch (error: unknown) {
      handlePollingFailure(error);
      return;
    }
    await delay(250);
  }
}

async function sendLocalDescription(
  peerConnection: RTCPeerConnection,
  expectedType: 'offer' | 'answer',
): Promise<void> {
  const description = peerConnection.localDescription;
  if (description?.type !== expectedType) {
    throw new Error('WebRTC did not produce the expected description');
  }
  assertRelayOnlySdp(description.sdp);
  await postCommand({
    kind: 'description',
    description: { type: description.type, sdp: description.sdp },
  });
}

async function waitForIceGathering(
  peerConnection: RTCPeerConnection,
): Promise<void> {
  if (peerConnection.iceGatheringState === 'complete') {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('TURN relay candidate gathering timed out'));
    }, 20_000);
    const onChange = (): void => {
      if (peerConnection.iceGatheringState === 'complete') {
        cleanup();
        resolve();
      }
    };
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener('icegatheringstatechange', onChange);
    };
    peerConnection.addEventListener('icegatheringstatechange', onChange);
  });
}

async function verifyRelayRoute(
  peerConnection: RTCPeerConnection,
): Promise<void> {
  if (routeVerified || routeVerificationStarted) {
    return;
  }
  routeVerificationStarted = true;
  const deadline = Date.now() + 5_000;
  while (!closed && Date.now() < deadline) {
    const reports = await peerConnection.getStats();
    const selectedPair = findSelectedCandidatePair(reports);
    if (selectedPair === null) {
      await delay(100);
      continue;
    }
    const local: unknown = reports.get(selectedPair.localCandidateId);
    const remote: unknown = reports.get(selectedPair.remoteCandidateId);
    if (
      !isRelayCandidate(local, 'local-candidate') ||
      !isRelayCandidate(remote, 'remote-candidate')
    ) {
      throw new Error('Call attempted to use a non-relay network route');
    }
    routeVerified = true;
    applyMediaPreferences();
    remoteVideo.srcObject = pendingRemoteStream;
    await postCommand({ kind: 'verified' });
    security.textContent = '● TURN relay verified · DTLS-SRTP E2EE';
    remoteVideo.classList.add('visible');
    setStatus('');
    return;
  }
  throw new Error('Unable to verify the selected TURN route');
}

function applyMediaPreferences(): void {
  const audio = localStream?.getAudioTracks()[0];
  if (audio !== undefined) {
    audio.enabled = routeVerified && wantsAudio;
  }
  const video = localStream?.getVideoTracks()[0];
  if (video !== undefined) {
    video.enabled = routeVerified && wantsVideo;
  }
}

interface SelectedCandidatePair {
  readonly localCandidateId: string;
  readonly remoteCandidateId: string;
}

function findSelectedCandidatePair(
  reports: RTCStatsReport,
): SelectedCandidatePair | null {
  for (const report of reports.values() as Iterable<unknown>) {
    if (
      isRecord(report) &&
      report['type'] === 'candidate-pair' &&
      report['state'] === 'succeeded' &&
      report['nominated'] === true &&
      typeof report['localCandidateId'] === 'string' &&
      typeof report['remoteCandidateId'] === 'string'
    ) {
      return {
        localCandidateId: report['localCandidateId'],
        remoteCandidateId: report['remoteCandidateId'],
      };
    }
  }
  return null;
}

function isRelayCandidate(
  value: unknown,
  type: 'local-candidate' | 'remote-candidate',
): boolean {
  return (
    isRecord(value) &&
    value['type'] === type &&
    value['candidateType'] === 'relay'
  );
}

function assertRelayOnlySdp(sdp: string): void {
  const candidates = sdp
    .split(/\r?\n/gu)
    .filter((line) => line.startsWith('a=candidate:'));
  if (candidates.length === 0) {
    throw new Error('No TURN relay candidate was available');
  }
  if (candidates.some((line) => !/(?:^|\s)typ\s+relay(?:\s|$)/u.test(line))) {
    throw new Error('A direct network candidate was blocked');
  }
}

async function postCommand(command: unknown): Promise<void> {
  await api('/api/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    keepalive: true,
  });
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    throw new Error(errorMessage(value));
  }
  return value;
}

function parseSession(value: unknown): BrowserSession {
  if (!isRecord(value)) {
    throw new Error('Local call session is invalid');
  }
  const role = value['role'];
  const callId = value['callId'];
  const peerLabel = value['peerLabel'];
  const turn = value['turnCredentials'];
  if (
    (role !== 'caller' && role !== 'callee') ||
    typeof callId !== 'string' ||
    typeof peerLabel !== 'string' ||
    !isRecord(turn) ||
    typeof turn['expiresAt'] !== 'number' ||
    !Array.isArray(turn['iceServers'])
  ) {
    throw new Error('Local call session is invalid');
  }
  const iceServers = turn['iceServers'].map(parseIceServer);
  const remoteOfferSdp = value['remoteOfferSdp'];
  if (remoteOfferSdp !== undefined && typeof remoteOfferSdp !== 'string') {
    throw new Error('Local call offer is invalid');
  }
  return {
    callId,
    role,
    peerLabel,
    turnCredentials: { iceServers, expiresAt: turn['expiresAt'] },
    ...(remoteOfferSdp === undefined ? {} : { remoteOfferSdp }),
  };
}

function parseIceServer(value: unknown): TurnIceServer {
  if (
    !isRecord(value) ||
    !Array.isArray(value['urls']) ||
    !value['urls'].every(
      (url) =>
        typeof url === 'string' &&
        (url.startsWith('turn:') || url.startsWith('turns:')),
    ) ||
    typeof value['username'] !== 'string' ||
    typeof value['credential'] !== 'string'
  ) {
    throw new Error('TURN relay configuration is invalid');
  }
  return {
    urls: value['urls'],
    username: value['username'],
    credential: value['credential'],
  };
}

function parseEvents(value: unknown): readonly BrowserEventEnvelope[] {
  if (!isRecord(value) || !Array.isArray(value['events'])) {
    throw new Error('Local call events are invalid');
  }
  return value['events'].map((item) => {
    if (!isRecord(item) || typeof item['sequence'] !== 'number') {
      throw new Error('Local call event is invalid');
    }
    const event = item['event'];
    if (!isRecord(event) || typeof event['kind'] !== 'string') {
      throw new Error('Local call event is invalid');
    }
    if (event['kind'] === 'ended' && typeof event['reason'] === 'string') {
      return {
        sequence: item['sequence'],
        event: { kind: 'ended', reason: event['reason'] },
      };
    }
    const description = event['description'];
    if (
      event['kind'] === 'remote-description' &&
      isRecord(description) &&
      (description['type'] === 'offer' || description['type'] === 'answer') &&
      typeof description['sdp'] === 'string'
    ) {
      return {
        sequence: item['sequence'],
        event: {
          kind: 'remote-description',
          description: { type: description['type'], sdp: description['sdp'] },
        },
      };
    }
    throw new Error('Local call event is invalid');
  });
}

function errorMessage(value: unknown): string {
  return isRecord(value) && typeof value['error'] === 'string'
    ? value['error']
    : 'Local call request failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function handlePollingFailure(error: unknown): void {
  if (!closed) {
    fail(error instanceof Error ? error.message : 'Call bridge failed');
  }
}

function requireElement<ElementType extends Element>(
  id: string,
  constructor: new () => ElementType,
): ElementType {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Call interface element ${id} is missing`);
  }
  return element;
}

function setStatus(message: string): void {
  const label = status.querySelector('span');
  if (label !== null) {
    label.textContent = message;
  }
  status.hidden = message.length === 0;
}

function fail(message: string): void {
  security.textContent = '● call failed closed';
  setStatus(message);
  if (!closed) {
    void postCommand({ kind: 'failure', reason: message });
  }
  closeMedia(message);
}

function closeMedia(message: string): void {
  if (closed) {
    return;
  }
  closed = true;
  connection?.close();
  for (const track of localStream?.getTracks() ?? []) {
    track.stop();
  }
  setStatus(message);
  security.textContent = routeVerified
    ? '● encrypted call ended'
    : '● no media route active';
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) =>
    window.setTimeout(resolve, milliseconds),
  );
}

import { Platform, PermissionsAndroid } from 'react-native';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import {
  ATTENDCLASS_PRIMARY_SERVICE_UUID,
  ATTENDCLASS_WRITE_CHAR_UUID,
  ATTENDCLASS_NOTIFY_CHAR_UUID,
  ATTENDCLASS_LEGACY_SERVICE_UUID,
  ATTENDCLASS_LEGACY_CHALLENGE_CHAR_UUID,
  ATTENDCLASS_LEGACY_SUBMISSION_CHAR_UUID,
  BleProtocol,
  BleProtocolMessage,
} from './BleProtocol';
import { BleFraming, FrameReassembler, BINARY_HEADER_SIZE } from './BleFraming';
import { DiagnosticLogger } from '../services/DiagnosticLogger';

export interface BleResolvedService {
  serviceUuid: string;
  writeCharUuid: string;
  notifyCharUuid: string;
}

export class BleConnectionManager {
  private bleManager: BleManager;
  private connectedDevice: Device | null = null;
  private isScanning = false;
  private cancelled = false;
  private negotiatedMtu = 23;
  private activeNotificationSub: Subscription | null = null;

  constructor(manager?: BleManager) {
    this.bleManager = manager || new BleManager();
  }

  public getNegotiatedMtu(): number {
    return this.negotiatedMtu;
  }

  public cancel(): void {
    this.cancelled = true;
    this.stopScan();
    this.disconnect();
  }

  public destroy(): void {
    this.stopScan();
    this.disconnect();
    try {
      this.bleManager.destroy();
    } catch {
      // ignore
    }
  }

  /**
   * Request Bluetooth permissions for Android 12+ (API 31+) and legacy location.
   */
  public async requestPermissions(): Promise<{ granted: boolean; error?: string }> {
    if (Platform.OS === 'ios') {
      return { granted: true };
    }

    if (Platform.OS === 'android') {
      const apiLevel =
        typeof Platform.Version === 'number'
          ? Platform.Version
          : parseInt(String(Platform.Version), 10);

      try {
        if (apiLevel >= 31) {
          const results = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          ]);

          const scanOk =
            results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
            PermissionsAndroid.RESULTS.GRANTED;
          const connectOk =
            results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
            PermissionsAndroid.RESULTS.GRANTED;

          if (!scanOk || !connectOk) {
            return {
              granted: false,
              error: 'Nearby devices / Bluetooth scan permissions were denied.',
            };
          }
          return { granted: true };
        } else {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            {
              title: 'Location Permission',
              message:
                'Location access is required by Android to discover nearby Bluetooth devices.',
              buttonPositive: 'Grant Permission',
            },
          );

          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
            return {
              granted: false,
              error: 'Location permission denied for Bluetooth scanning.',
            };
          }
          return { granted: true };
        }
      } catch (err: unknown) {
        return {
          granted: false,
          error: `Permission request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return { granted: true };
  }

  /**
   * Check if Bluetooth adapter is powered on.
   */
  public async checkBluetoothState(): Promise<{ ok: boolean; state: State; error?: string }> {
    try {
      const state = await this.bleManager.state();
      if (state === State.PoweredOn) {
        return { ok: true, state };
      }
      if (state === State.PoweredOff) {
        return { ok: false, state, error: 'Bluetooth is turned off. Please turn on Bluetooth.' };
      }
      if (state === State.Unauthorized) {
        return { ok: false, state, error: 'Bluetooth permission is unauthorized.' };
      }
      return { ok: false, state, error: `Bluetooth unavailable (current state: ${state}).` };
    } catch (err: unknown) {
      return {
        ok: false,
        state: State.Unknown,
        error: `Failed to check Bluetooth state: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Scan for a classroom ESP32 matching the scanned QR device_id and/or service UUID.
   */
  public async scanForTerminal(params: {
    targetDeviceId: string;
    targetServiceUuid?: string;
    timeoutMs?: number;
    rssiThreshold?: number;
  }): Promise<Device> {
    this.cancelled = false;
    const timeoutMs = params.timeoutMs ?? 15000;
    const rssiLimit = params.rssiThreshold ?? -90;

    const perm = await this.requestPermissions();
    if (!perm.granted) {
      throw new Error(`PERMISSIONS_DENIED: ${perm.error}`);
    }

    const bt = await this.checkBluetoothState();
    if (!bt.ok) {
      throw new Error(`BLUETOOTH_OFF: ${bt.error}`);
    }

    const serviceUuids = [
      params.targetServiceUuid || ATTENDCLASS_PRIMARY_SERVICE_UUID,
      ATTENDCLASS_LEGACY_SERVICE_UUID,
    ];

    return new Promise<Device>((resolve, reject) => {
      let timeoutTimer: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        this.stopScan();
      };

      timeoutTimer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `DISCOVERY_TIMEOUT: Could not find classroom device "${params.targetDeviceId}" over Bluetooth. Make sure you are near the classroom terminal.`,
          ),
        );
      }, timeoutMs);

      this.isScanning = true;

      this.bleManager.startDeviceScan(
        serviceUuids,
        { allowDuplicates: false },
        (error, device) => {
          if (this.cancelled) {
            cleanup();
            reject(new Error('TRANSACTION_CANCELLED: Scanning cancelled by user.'));
            return;
          }

          if (error) {
            cleanup();
            reject(new Error(`SCAN_ERROR: ${error.message}`));
            return;
          }

          if (!device) return;

          const devName = (device.name || device.localName || '').trim();
          const targetId = params.targetDeviceId.trim();

          // Match by device ID, terminal name, or UUID
          const matchesTarget =
            devName === targetId ||
            devName.includes(targetId) ||
            targetId.includes(devName) ||
            devName.startsWith('AttendESP_') ||
            devName.startsWith('TERM_') ||
            devName.startsWith('ESP32_');

          const passesRssi =
            typeof device.rssi === 'number' ? device.rssi >= rssiLimit : true;

          if (matchesTarget && passesRssi) {
            cleanup();
            DiagnosticLogger.info('BLE_SCAN', 'Discovered target classroom terminal', {
              name: devName,
              id: device.id,
              rssi: device.rssi,
            });
            resolve(device);
          }
        },
      );
    });
  }

  public stopScan(): void {
    if (this.isScanning) {
      try {
        this.bleManager.stopDeviceScan();
      } catch {
        // ignore
      }
      this.isScanning = false;
    }
  }

  /**
   * Connect to device, negotiate MTU, and discover GATT services.
   */
  public async connect(device: Device): Promise<Device> {
    try {
      const connected = await this.bleManager.connectToDevice(device.id, {
        timeout: 10000,
        autoConnect: false,
      });

      let negotiated = 23;
      if (Platform.OS === 'android') {
        try {
          const withMtu = await connected.requestMTU(512);
          negotiated = withMtu.mtu || 512;
        } catch {
          negotiated = connected.mtu || 23;
        }
      } else {
        negotiated = connected.mtu || 23;
      }

      this.negotiatedMtu = Math.max(23, negotiated);

      await connected.discoverAllServicesAndCharacteristics();
      this.connectedDevice = connected;

      DiagnosticLogger.info('BLE_CONNECT', 'Established BLE connection to terminal', {
        id: device.id,
        negotiatedMtu: this.negotiatedMtu,
      });

      return connected;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CONNECTION_FAILED: Could not establish BLE connection: ${msg}`);
    }
  }

  /**
   * Resolve GATT service and characteristic UUIDs (primary or legacy).
   */
  public async resolveGattService(
    device: Device,
    preferredServiceUuid?: string,
  ): Promise<BleResolvedService> {
    const services = await device.services();
    const serviceUuids = services.map((s) => s.uuid.toLowerCase());

    const targetService = (preferredServiceUuid || ATTENDCLASS_PRIMARY_SERVICE_UUID).toLowerCase();

    if (serviceUuids.includes(targetService)) {
      return {
        serviceUuid: targetService,
        writeCharUuid: ATTENDCLASS_WRITE_CHAR_UUID,
        notifyCharUuid: ATTENDCLASS_NOTIFY_CHAR_UUID,
      };
    }

    if (serviceUuids.includes(ATTENDCLASS_LEGACY_SERVICE_UUID.toLowerCase())) {
      return {
        serviceUuid: ATTENDCLASS_LEGACY_SERVICE_UUID,
        writeCharUuid: ATTENDCLASS_LEGACY_SUBMISSION_CHAR_UUID,
        notifyCharUuid: ATTENDCLASS_LEGACY_CHALLENGE_CHAR_UUID,
      };
    }

    // Default to preferred or primary
    return {
      serviceUuid: preferredServiceUuid || ATTENDCLASS_PRIMARY_SERVICE_UUID,
      writeCharUuid: ATTENDCLASS_WRITE_CHAR_UUID,
      notifyCharUuid: ATTENDCLASS_NOTIFY_CHAR_UUID,
    };
  }

  /**
   * Subscribe to notifications on the notify characteristic.
   */
  public async subscribeToNotifications(
    device: Device,
    service: BleResolvedService,
    onMessage: (msg: BleProtocolMessage) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const reassembler = new FrameReassembler(15000);

    this.activeNotificationSub = device.monitorCharacteristicForService(
      service.serviceUuid,
      service.notifyCharUuid,
      (error, characteristic) => {
        if (error) {
          onError(new Error(`NOTIFICATION_ERROR: ${error.message}`));
          return;
        }

        if (!characteristic?.value) return;

        try {
          const rawBytes = new Uint8Array(Buffer.from(characteristic.value, 'base64'));
          const completeText = reassembler.processChunk(rawBytes);

          if (completeText) {
            const parsed = BleProtocol.parseMessage(completeText);
            onMessage(parsed);
          }
        } catch (e: unknown) {
          // Check if payload was sent raw unfragmented
          try {
            const decoded = Buffer.from(characteristic.value, 'base64').toString('utf-8');
            const parsed = BleProtocol.parseMessage(decoded);
            onMessage(parsed);
          } catch {
            onError(new Error(`PACKET_PARSE_ERROR: ${e instanceof Error ? e.message : String(e)}`));
          }
        }
      },
    );
  }

  /**
   * Send a protocol message over the write characteristic using MTU-aware binary framing.
   */
  public async sendMessage(
    device: Device,
    service: BleResolvedService,
    msg: BleProtocolMessage,
  ): Promise<void> {
    const serialized = BleProtocol.serializeMessage(msg);

    // Compute transaction ID from request_id or random uint16
    let txId = 0x1234;
    if ('request_id' in msg && typeof msg.request_id === 'string') {
      for (let i = 0; i < msg.request_id.length; i++) {
        /* eslint-disable-next-line no-bitwise */
        txId = (txId * 31 + msg.request_id.charCodeAt(i)) & 0xffff;
      }
    }

    // Usable bytes per chunk is MTU - 3 bytes ATT - 6 bytes framing header
    const effectiveAttPayload = Math.max(20, this.negotiatedMtu - 3);
    const usableChunk = Math.max(8, effectiveAttPayload - BINARY_HEADER_SIZE);

    const frames = BleFraming.framePayload(serialized, txId, usableChunk);

    for (const frame of frames) {
      if (this.cancelled) {
        throw new Error('TRANSACTION_CANCELLED: Write cancelled by user.');
      }

      const base64Chunk = Buffer.from(frame).toString('base64');
      await device.writeCharacteristicWithResponseForService(
        service.serviceUuid,
        service.writeCharUuid,
        base64Chunk,
      );
    }
  }

  /**
   * Disconnect and clear listeners.
   */
  public async disconnect(): Promise<void> {
    if (this.activeNotificationSub) {
      try {
        this.activeNotificationSub.remove();
      } catch {
        // ignore
      }
      this.activeNotificationSub = null;
    }

    if (this.connectedDevice) {
      try {
        await this.bleManager.cancelDeviceConnection(this.connectedDevice.id);
      } catch {
        // ignore
      }
      this.connectedDevice = null;
    }
  }
}

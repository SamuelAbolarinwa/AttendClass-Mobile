import { Platform, PermissionsAndroid } from 'react-native';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import {
  ATTENDCLASS_SERVICE_UUID,
  CHALLENGE_CHAR_UUID,
  SUBMISSION_CHAR_UUID,
  ACK_CHAR_UUID,
  AttendanceProtocol,
  TerminalChallengePayload,
  AttendanceSubmissionPayload,
  TerminalAckPayload,
} from './AttendanceProtocol';
import { DiagnosticLogger } from './DiagnosticLogger';

export interface BleScanOptions {
  timeoutMs?: number;
  rssiThreshold?: number; // e.g., -80 dBm
  targetTerminalId?: string;
}

export type BleTransportErrorCode =
  | 'PERMISSIONS_DENIED'
  | 'BLUETOOTH_OFF'
  | 'BLUETOOTH_UNAUTHORIZED'
  | 'DISCOVERY_TIMEOUT'
  | 'CONNECTION_FAILED'
  | 'DISCONNECTED'
  | 'CHALLENGE_READ_FAILED'
  | 'SUBMISSION_WRITE_FAILED'
  | 'ACK_TIMEOUT'
  | 'TERMINAL_REJECTED'
  | 'TRANSACTION_CANCELLED';

export class BleTransportService {
  private bleManager: BleManager;
  private connectedDevice: Device | null = null;
  private scanSubscription: Subscription | null = null;
  private isScanning = false;
  private cancelled = false;

  constructor(manager?: BleManager) {
    this.bleManager = manager || new BleManager();
  }

  public destroy(): void {
    this.stopScan();
    this.disconnect();
    this.bleManager.destroy();
  }

  public cancel(): void {
    this.cancelled = true;
    this.stopScan();
    this.disconnect();
  }

  /**
   * Request platform-appropriate Bluetooth permissions at runtime.
   */
  public async requestPermissions(): Promise<{ granted: boolean; error?: string }> {
    if (Platform.OS === 'ios') {
      return { granted: true };
    }

    if (Platform.OS === 'android') {
      const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);

      try {
        if (apiLevel >= 31) {
          const results = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          ]);

          const scanOk = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED;
          const connectOk = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED;

          if (!scanOk || !connectOk) {
            return { granted: false, error: 'Nearby devices / Bluetooth permissions denied.' };
          }
          return { granted: true };
        } else {
          // Android < 12 requires Location for BLE scanning
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            {
              title: 'Location Permission',
              message: 'Location access is required to discover nearby Bluetooth attendance terminals.',
              buttonPositive: 'OK',
            },
          );

          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
            return { granted: false, error: 'Location permission denied for Bluetooth scanning.' };
          }
          return { granted: true };
        }
      } catch (err: unknown) {
        return { granted: false, error: `Permission request error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    return { granted: true };
  }

  /**
   * Check whether Bluetooth adapter is enabled and ready.
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
        return { ok: false, state, error: 'Bluetooth permission unauthorized.' };
      }
      return { ok: false, state, error: `Bluetooth unavailable (${state}).` };
    } catch (err: unknown) {
      return { ok: false, state: State.Unknown, error: `Failed to query Bluetooth state: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Scan for authorized attendance terminal.
   */
  public async scanForTerminal(
    options: BleScanOptions = {},
    onTerminalFound?: (device: Device) => void,
  ): Promise<Device> {
    this.cancelled = false;
    const timeoutMs = options.timeoutMs ?? 15000;
    const rssiLimit = options.rssiThreshold ?? -85;

    const perm = await this.requestPermissions();
    if (!perm.granted) {
      throw new Error(`PERMISSIONS_DENIED: ${perm.error}`);
    }

    const bt = await this.checkBluetoothState();
    if (!bt.ok) {
      throw new Error(`BLUETOOTH_OFF: ${bt.error}`);
    }

    return new Promise<Device>((resolve, reject) => {
      let timeoutTimer: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        this.stopScan();
      };

      timeoutTimer = setTimeout(() => {
        cleanup();
        reject(new Error('DISCOVERY_TIMEOUT: Timed out waiting for attendance terminal BLE broadcast.'));
      }, timeoutMs);

      this.isScanning = true;

      this.bleManager.startDeviceScan(
        [ATTENDCLASS_SERVICE_UUID],
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

          const name = device.name || device.localName || '';
          const isTargetName = name.startsWith('AttendESP_') || name.startsWith('TERM_');
          const passesRssi = typeof device.rssi === 'number' ? device.rssi >= rssiLimit : true;

          if (isTargetName && passesRssi) {
            cleanup();
            if (onTerminalFound) onTerminalFound(device);
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
   * Connect to terminal and discover GATT services.
   */
  public async connect(device: Device): Promise<Device> {
    DiagnosticLogger.info('BLE_CONNECT', `Connecting to terminal ${device.id}`);
    try {
      const connected = await this.bleManager.connectToDevice(device.id, {
        timeout: 10000,
        autoConnect: false,
      });

      if (Platform.OS === 'android') {
        try {
          await connected.requestMTU(512);
        } catch {
          // MTU request optional
        }
      }

      await connected.discoverAllServicesAndCharacteristics();
      this.connectedDevice = connected;
      DiagnosticLogger.info('BLE_CONNECT', `Connected and discovered services for ${device.id}`);
      return connected;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CONNECTION_FAILED: Could not establish BLE connection to terminal: ${msg}`);
    }
  }

  /**
   * Read fresh challenge from terminal.
   */
  public async fetchChallenge(device: Device): Promise<TerminalChallengePayload> {
    try {
      const char = await device.readCharacteristicForService(
        ATTENDCLASS_SERVICE_UUID,
        CHALLENGE_CHAR_UUID,
      );

      if (!char.value) {
        throw new Error('Empty challenge characteristic value');
      }

      const decoded = Buffer.from(char.value, 'base64').toString('utf-8');
      return AttendanceProtocol.parseChallenge(decoded);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CHALLENGE_READ_FAILED: Failed reading challenge from terminal: ${msg}`);
    }
  }

  /**
   * Submit signed attendance response and await persistent SD acknowledgement.
   */
  public async submitAttendanceAndAwaitAck(
    device: Device,
    submission: AttendanceSubmissionPayload,
    timeoutMs = 12000,
  ): Promise<TerminalAckPayload> {
    const rawSubmissionBase64 = AttendanceProtocol.serializeSubmission(submission);

    // Write submission to characteristic
    try {
      await device.writeCharacteristicWithResponseForService(
        ATTENDCLASS_SERVICE_UUID,
        SUBMISSION_CHAR_UUID,
        rawSubmissionBase64,
      );
      DiagnosticLogger.info('BLE_SUBMIT', 'Attendance packet written to terminal characteristic');
    } catch (writeErr: unknown) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      throw new Error(`SUBMISSION_WRITE_FAILED: Failed to write attendance payload to terminal: ${msg}`);
    }

    // Await durable-save acknowledgement on ACK characteristic
    return new Promise<TerminalAckPayload>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let sub: Subscription | null = null;

      const finish = () => {
        clearTimeout(timer);
        if (sub) {
          sub.remove();
          sub = null;
        }
      };

      timer = setTimeout(async () => {
        finish();
        // One fallback read before timing out
        try {
          const char = await device.readCharacteristicForService(
            ATTENDCLASS_SERVICE_UUID,
            ACK_CHAR_UUID,
          );
          if (char.value) {
            const decoded = Buffer.from(char.value, 'base64').toString('utf-8');
            const ack = AttendanceProtocol.parseAck(decoded, submission.event_id);
            resolve(ack);
            return;
          }
        } catch {
          // ignore fallback error
        }
        reject(new Error('ACK_TIMEOUT: Terminal did not confirm durable persistence within timeout period.'));
      }, timeoutMs);

      // Monitor ACK characteristic
      try {
        sub = device.monitorCharacteristicForService(
          ATTENDCLASS_SERVICE_UUID,
          ACK_CHAR_UUID,
          (error, characteristic) => {
            if (error) {
              finish();
              reject(new Error(`ACK_MONITOR_ERROR: ${error.message}`));
              return;
            }

            if (characteristic?.value) {
              try {
                const decoded = Buffer.from(characteristic.value, 'base64').toString('utf-8');
                const ack = AttendanceProtocol.parseAck(decoded, submission.event_id);
                finish();
                resolve(ack);
              } catch (parseErr: unknown) {
                finish();
                reject(parseErr);
              }
            }
          },
        );
      } catch (monErr: unknown) {
        finish();
        reject(monErr);
      }
    });
  }

  /**
   * Cleanly disconnect connected terminal.
   */
  public async disconnect(): Promise<void> {
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

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { isCountableDay } from '../utils/attendanceHelpers';
import { AttendanceHeatmap } from '../components/AttendanceHeatmap';
import { OfflineDashboardStore } from '../services/OfflineDashboardStore';
import { T } from '../theme/tokens';

export default function DashboardScreen({ navigation }: any) {
  const { account, isDeviceEnrolled, authStatus } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [stats, setStats] = useState({ present: 0, absent: 0, percentage: 0 });
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [trackingStart, setTrackingStart] = useState<string>('');
  const [endDate, setEndDate] = useState<Date>(new Date());
  const [cancelledDays, setCancelledDays] = useState<Set<string>>(new Set());

  const fetchDashboardData = useCallback(async () => {
    if (!account) return;

    // 1. First, immediately load locally cached dashboard state and local receipts
    try {
      const cached = await OfflineDashboardStore.loadCachedDashboard(account.id);
      if (cached) {
        setTrackingStart(cached.trackingStartDate);
        setEndDate(new Date(cached.trackingEndDateIso));
        setStats(cached.stats);

        const { logs: combinedLogs } =
          await OfflineDashboardStore.getCombinedAttendanceLogs(
            account.id,
            cached.serverLogs,
          );
        setLogs(combinedLogs);
      } else {
        const { logs: localOnly } =
          await OfflineDashboardStore.getCombinedAttendanceLogs(account.id, []);
        setLogs(localOnly);
      }
    } catch {
      // Local cache read non-fatal
    }

    // 2. Attempt online refresh if online
    try {
      const [profileRes, settingsRes, cancelledRes, logsRes] = await Promise.all([
        supabase
          .from('profiles')
          .select('created_at, tracking_start_date')
          .eq('id', account.id)
          .single(),
        supabase.from('app_settings').select('tracking_period_end_date').single(),
        supabase.from('cancelled_days').select('cancelled_date'),
        supabase.rpc('platform_get_my_attendance', { p_token: account.token }),
      ]);

      if (profileRes.error) throw profileRes.error;
      if (settingsRes.error) throw settingsRes.error;
      if (cancelledRes.error) throw cancelledRes.error;
      if (logsRes.error) throw logsRes.error;

      const res = logsRes.data as any;
      if (!res.ok) throw new Error(res.error || 'Failed to fetch attendance');

      const userServerLogs = res.data || [];
      const cancelledSet = new Set<string>(
        cancelledRes.data.map((d: any) => d.cancelled_date),
      );
      const trackingStartStr =
        profileRes.data.tracking_start_date ||
        profileRes.data.created_at.split('T')[0];
      const endDateObj = settingsRes.data?.tracking_period_end_date
        ? new Date(settingsRes.data.tracking_period_end_date)
        : new Date();

      setTrackingStart(trackingStartStr);
      setEndDate(endDateObj);
      setCancelledDays(cancelledSet);
      setIsOfflineMode(false);

      // Merge server logs with locally verified terminal receipts
      const { logs: combinedLogs } =
        await OfflineDashboardStore.getCombinedAttendanceLogs(
          account.id,
          userServerLogs,
        );
      setLogs(combinedLogs);

      let presentCount = 0;
      let absentCount = 0;
      const today = new Date();
      const end = endDateObj < today ? endDateObj : today;

      for (
        let d = new Date(trackingStartStr);
        d <= end;
        d.setDate(d.getDate() + 1)
      ) {
        const dayStr = d.toISOString().split('T')[0];
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        if (!isCountableDay(dayStr, trackingStartStr, cancelledSet)) continue;
        const wasPresent = combinedLogs.some((log: any) =>
          log.verified_at?.startsWith(dayStr),
        );
        wasPresent ? presentCount++ : absentCount++;
      }

      const total = presentCount + absentCount;
      const computedStats = {
        present: presentCount,
        absent: absentCount,
        percentage: total > 0 ? (presentCount / total) * 100 : 0,
      };
      setStats(computedStats);

      // Persist to local offline dashboard store
      await OfflineDashboardStore.saveCachedDashboard(account.id, {
        accountId: account.id,
        fullName: account.full_name,
        matricNumber: account.matric_number,
        trackingStartDate: trackingStartStr,
        trackingEndDateIso: endDateObj.toISOString(),
        stats: computedStats,
        serverLogs: userServerLogs,
        lastSyncedAtIso: new Date().toISOString(),
      });
    } catch {
      // Network unreachable or session expired: continue cleanly in offline mode
      setIsOfflineMode(true);
      const { logs: combinedLogs } =
        await OfflineDashboardStore.getCombinedAttendanceLogs(account.id, []);
      if (combinedLogs.length > 0) {
        setLogs(combinedLogs);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [account]);

  React.useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      setLoading(true);
      fetchDashboardData();
    });
    return unsub;
  }, [navigation, fetchDashboardData]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchDashboardData();
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={T.colors.surface} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.greeting}>AttendClass</Text>
          <Text style={styles.name}>👋 {account?.full_name}</Text>
          <View style={styles.deviceStatusBadge}>
            <Text style={styles.deviceStatusText}>
              {isDeviceEnrolled
                ? '📱 Authorised Phone (Hardware Key)'
                : '⚠️ Phone Not Enrolled'}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.settingsBtn}
          onPress={() => navigation.navigate('Settings')}
        >
          <Text style={styles.settingsBtnText}>⚙️</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={T.colors.primary}
          />
        }
      >
        {/* Offline Mode Banner */}
        {isOfflineMode || authStatus === 'OFFLINE_AUTHORISED' ? (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineBannerText}>
              📡 Operating in Offline Mode • Viewing Verified Local &amp; Cached Records
            </Text>
          </View>
        ) : null}

        {/* Device Enrolment Warning Banner if not enrolled */}
        {!isDeviceEnrolled && !loading && (
          <View style={styles.enrollBanner}>
            <View style={styles.enrollBannerContent}>
              <Text style={styles.enrollBannerTitle}>Set Up This Phone</Text>
              <Text style={styles.enrollBannerText}>
                Enrol this phone to mark attendance securely using your fingerprint.
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => navigation.navigate('Settings')}
              style={styles.enrollBannerBtn}
            >
              <Text style={styles.enrollBannerBtnText}>Set Up</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Stats row */}
        <View style={styles.statsRow}>
          {[
            { label: 'Present', value: stats.present, color: T.colors.success },
            { label: 'Absent', value: stats.absent, color: T.colors.error },
            { label: 'Rate', value: `${stats.percentage.toFixed(0)}%`, color: T.colors.primary },
          ].map(({ label, value, color }) => (
            <View key={label} style={styles.statCard}>
              <Text style={[styles.statValue, { color }]}>{loading ? '—' : value}</Text>
              <Text style={styles.statLabel}>{label}</Text>
            </View>
          ))}
        </View>

        {/* Heatmap */}
        {loading ? (
          <View style={styles.heatmapSkeleton}>
            <ActivityIndicator color={T.colors.primary} />
          </View>
        ) : trackingStart ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Attendance Calendar</Text>
            <AttendanceHeatmap
              logs={logs}
              trackingStartDate={trackingStart}
              endDate={endDate}
              cancelledDays={cancelledDays}
            />
          </View>
        ) : null}

        {/* Recent history */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recent Attendance</Text>
          {loading ? (
            <ActivityIndicator color={T.colors.primary} style={styles.loader} />
          ) : logs.length === 0 ? (
            <Text style={styles.emptyText}>No attendance records found.</Text>
          ) : (
            logs.slice(0, 10).map((log, idx) => {
              const d = new Date(log.verified_at);
              const isLocalReceipt = log.syncStatus === 'SAVED_LOCALLY_PENDING_SYNC';

              return (
                <View
                  key={log.id || log.event_id || idx}
                  style={[styles.historyRow, idx === 0 && styles.historyRowFirst]}
                >
                  <View>
                    <Text style={styles.historyDate}>
                      {d.toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </Text>
                    <Text style={styles.historyTime}>
                      {d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                  <View style={styles.badges}>
                    <View
                      style={[
                        styles.methodBadge,
                        isLocalReceipt && styles.methodBadgeOffline,
                      ]}
                    >
                      <Text
                        style={[
                          styles.methodBadgeText,
                          isLocalReceipt && styles.methodBadgeOfflineText,
                        ]}
                      >
                        {isLocalReceipt ? 'ESP32 Terminal' : log.method || 'Offline BLE'}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.presentBadge,
                        isLocalReceipt && styles.presentBadgeLocal,
                      ]}
                    >
                      <Text
                        style={[
                          styles.presentBadgeText,
                          isLocalReceipt && styles.presentBadgeLocalText,
                        ]}
                      >
                        {isLocalReceipt ? 'Saved on ESP32' : 'Present'}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </View>

        <View style={styles.bottomSpacer} />
      </ScrollView>

      {/* Primary Action FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('QRScanner')}
        activeOpacity={0.85}
      >
        <Text style={styles.fabText}>Scan Attendance QR →</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: T.colors.bg },
  bottomSpacer: { height: 96 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: T.colors.surface,
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: T.colors.border,
  },
  headerLeft: { flex: 1 },
  greeting: { fontSize: T.fontSize.xl, fontWeight: '800', color: T.colors.text },
  name: { fontSize: T.fontSize.sm, color: T.colors.textSecondary, marginTop: 2 },
  deviceStatusBadge: {
    marginTop: 4,
    alignSelf: 'flex-start',
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: T.radius.sm,
  },
  deviceStatusText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155',
  },
  settingsBtn: { padding: T.spacing.sm },
  settingsBtnText: { fontSize: 24 },
  scroll: { flex: 1 },
  scrollContent: { padding: T.spacing.md, gap: T.spacing.md },
  offlineBanner: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
    borderWidth: 1,
    borderRadius: T.radius.md,
    padding: T.spacing.sm,
  },
  offlineBannerText: {
    color: '#1d4ed8',
    fontSize: T.fontSize.xs,
    fontWeight: '700',
    textAlign: 'center',
  },
  statsRow: { flexDirection: 'row', gap: T.spacing.sm },
  statCard: {
    flex: 1,
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    alignItems: 'center',
    ...T.shadow.sm,
  },
  enrollBanner: {
    backgroundColor: '#fffbeb',
    borderColor: '#fde68a',
    borderWidth: 1,
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  enrollBannerContent: { flex: 1 },
  enrollBannerTitle: { fontSize: T.fontSize.sm, fontWeight: '700', color: '#92400e' },
  enrollBannerText: { fontSize: T.fontSize.xs, color: '#b45309', marginTop: 2 },
  enrollBannerBtn: {
    backgroundColor: '#d97706',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: T.radius.sm,
  },
  enrollBannerBtnText: { color: '#fff', fontSize: T.fontSize.xs, fontWeight: '700' },
  statValue: { fontSize: 28, fontWeight: '800' },
  statLabel: {
    fontSize: T.fontSize.xs,
    fontWeight: '600',
    color: T.colors.textMuted,
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.lg,
    padding: T.spacing.md,
    ...T.shadow.sm,
  },
  cardTitle: {
    fontSize: T.fontSize.base,
    fontWeight: '700',
    color: T.colors.text,
    marginBottom: T.spacing.md,
  },
  heatmapSkeleton: {
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.lg,
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    ...T.shadow.sm,
  },
  loader: { paddingVertical: T.spacing.lg },
  emptyText: { color: T.colors.textMuted, textAlign: 'center', paddingVertical: T.spacing.lg },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: T.spacing.sm + 4,
    borderTopWidth: 1,
    borderTopColor: T.colors.border,
  },
  historyRowFirst: { borderTopWidth: 0 },
  historyDate: { fontSize: T.fontSize.sm, fontWeight: '600', color: T.colors.text },
  historyTime: { fontSize: T.fontSize.xs, color: T.colors.textMuted, marginTop: 2 },
  badges: { flexDirection: 'row', gap: T.spacing.sm },
  methodBadge: {
    backgroundColor: T.colors.bg,
    borderRadius: T.radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  methodBadgeOffline: {
    backgroundColor: '#f3e8ff',
  },
  methodBadgeText: { fontSize: T.fontSize.xs, fontWeight: '600', color: T.colors.textSecondary },
  methodBadgeOfflineText: { color: '#7e22ce', fontWeight: '700' },
  presentBadge: {
    backgroundColor: T.colors.successBg,
    borderRadius: T.radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  presentBadgeLocal: {
    backgroundColor: '#e0f2fe',
  },
  presentBadgeText: { fontSize: T.fontSize.xs, fontWeight: '600', color: T.colors.success },
  presentBadgeLocalText: { color: '#0369a1', fontWeight: '700' },
  fab: {
    position: 'absolute',
    bottom: T.spacing.lg,
    left: T.spacing.md,
    right: T.spacing.md,
    backgroundColor: T.colors.primary,
    paddingVertical: T.spacing.md,
    borderRadius: T.radius.lg,
    alignItems: 'center',
    ...T.shadow.md,
    shadowColor: T.colors.primary,
  },
  fabText: { color: '#fff', fontSize: T.fontSize.base, fontWeight: '800', letterSpacing: 0.3 },
});

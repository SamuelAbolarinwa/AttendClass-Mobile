import React, { useState } from 'react';
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
import { T } from '../theme/tokens';

export default function DashboardScreen({ navigation }: any) {
  const { account, hasMobileEnrollment } = useAuth();
  const [dismissBanner, setDismissBanner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [stats, setStats] = useState({ present: 0, absent: 0, percentage: 0 });
  const [error, setError] = useState<string | null>(null);
  const [trackingStart, setTrackingStart] = useState<string>('');
  const [endDate, setEndDate] = useState<Date>(new Date());
  const [cancelledDays, setCancelledDays] = useState<Set<string>>(new Set());

  const fetchDashboardData = async () => {
    if (!account) return;
    setError(null);

    try {
      const [profileRes, settingsRes, cancelledRes, logsRes] = await Promise.all([
        supabase.from('profiles').select('created_at, tracking_start_date').eq('id', account.id).single(),
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

      const userLogs = res.data || [];
      setLogs(userLogs);

      const cancelledSet = new Set<string>(cancelledRes.data.map((d: any) => d.cancelled_date));
      const trackingStartStr = profileRes.data.tracking_start_date || profileRes.data.created_at.split('T')[0];
      const endDateObj = settingsRes.data?.tracking_period_end_date
        ? new Date(settingsRes.data.tracking_period_end_date)
        : new Date();

      setTrackingStart(trackingStartStr);
      setEndDate(endDateObj);
      setCancelledDays(cancelledSet);

      let presentCount = 0;
      let absentCount = 0;
      const today = new Date();
      const end = endDateObj < today ? endDateObj : today;

      for (let d = new Date(trackingStartStr); d <= end; d.setDate(d.getDate() + 1)) {
        const dayStr = d.toISOString().split('T')[0];
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        if (!isCountableDay(dayStr, trackingStartStr, cancelledSet)) continue;
        const wasPresent = userLogs.some((log: any) => log.verified_at.startsWith(dayStr));
        wasPresent ? presentCount++ : absentCount++;
      }

      const total = presentCount + absentCount;
      setStats({ present: presentCount, absent: absentCount, percentage: total > 0 ? (presentCount / total) * 100 : 0 });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  React.useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      setLoading(true);
      fetchDashboardData();
    });
    return unsub;
  }, [navigation, account]);

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
          <Text style={styles.greeting}>My Attendance</Text>
          <Text style={styles.name}>👋 {account?.full_name}</Text>
        </View>
        <TouchableOpacity style={styles.settingsBtn} onPress={() => navigation.navigate('Settings')}>
          <Text style={styles.settingsBtnText}>⚙️</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.colors.primary} />}
      >
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        )}

        {!hasMobileEnrollment && !dismissBanner && !loading && (
          <View style={styles.enrollBanner}>
            <View style={styles.enrollBannerContent}>
              <Text style={styles.enrollBannerTitle}>Set up Face ID</Text>
              <Text style={styles.enrollBannerText}>Register your face for quick check-in.</Text>
            </View>
            <View style={styles.enrollBannerActions}>
              <TouchableOpacity onPress={() => navigation.navigate('EnrollFace')} style={styles.enrollBannerBtn}>
                <Text style={styles.enrollBannerBtnText}>Setup</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setDismissBanner(true)} style={styles.enrollBannerDismiss}>
                <Text style={styles.enrollBannerDismissText}>Later</Text>
              </TouchableOpacity>
            </View>
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
          <Text style={styles.cardTitle}>Recent History</Text>
          {loading ? (
            <ActivityIndicator color={T.colors.primary} style={styles.loader} />
          ) : logs.length === 0 ? (
            <Text style={styles.emptyText}>No attendance records yet.</Text>
          ) : (
            logs.slice(0, 10).map((log, idx) => {
              const d = new Date(log.verified_at);
              return (
                <View key={log.id || idx} style={[styles.historyRow, idx === 0 && styles.historyRowFirst]}>
                  <View>
                    <Text style={styles.historyDate}>{d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
                    <Text style={styles.historyTime}>{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                  </View>
                  <View style={styles.badges}>
                    <View style={styles.methodBadge}>
                      <Text style={styles.methodBadgeText}>{log.method}</Text>
                    </View>
                    <View style={styles.presentBadge}>
                      <Text style={styles.presentBadgeText}>Present</Text>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </View>

        <View style={{ height: 96 }} />
      </ScrollView>

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('CheckIn')}
        activeOpacity={0.85}
      >
        <Text style={styles.fabText}>Check In Now →</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: T.colors.bg },
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
  settingsBtn: { padding: T.spacing.sm },
  settingsBtnText: { fontSize: 24 },
  scroll: { flex: 1 },
  scrollContent: { padding: T.spacing.md, gap: T.spacing.md },
  errorBox: {
    backgroundColor: T.colors.errorBg,
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  errorText: { color: T.colors.error, fontSize: T.fontSize.sm },
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
    marginBottom: T.spacing.sm,
  },
  enrollBannerContent: { flex: 1 },
  enrollBannerTitle: { fontSize: T.fontSize.sm, fontWeight: '700', color: '#92400e' },
  enrollBannerText: { fontSize: T.fontSize.xs, color: '#b45309', marginTop: 2 },
  enrollBannerActions: { flexDirection: 'row', gap: 8 },
  enrollBannerBtn: { backgroundColor: '#d97706', paddingHorizontal: 12, paddingVertical: 6, borderRadius: T.radius.sm },
  enrollBannerBtnText: { color: '#fff', fontSize: T.fontSize.xs, fontWeight: '600' },
  enrollBannerDismiss: { paddingHorizontal: 8, paddingVertical: 6 },
  enrollBannerDismissText: { color: '#b45309', fontSize: T.fontSize.xs, fontWeight: '600' },
  statValue: { fontSize: 28, fontWeight: '800' },
  statLabel: { fontSize: T.fontSize.xs, fontWeight: '600', color: T.colors.textMuted, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  card: {
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.lg,
    padding: T.spacing.md,
    ...T.shadow.sm,
  },
  cardTitle: { fontSize: T.fontSize.base, fontWeight: '700', color: T.colors.text, marginBottom: T.spacing.md },
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
  methodBadge: { backgroundColor: T.colors.bg, borderRadius: T.radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  methodBadgeText: { fontSize: T.fontSize.xs, fontWeight: '600', color: T.colors.textSecondary },
  presentBadge: { backgroundColor: T.colors.successBg, borderRadius: T.radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  presentBadgeText: { fontSize: T.fontSize.xs, fontWeight: '600', color: T.colors.success },
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

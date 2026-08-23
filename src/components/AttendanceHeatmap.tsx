import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { T } from '../theme/tokens';

interface Log {
  verified_at: string;
}

interface AttendanceHeatmapProps {
  logs: Log[];
  trackingStartDate: string;
  endDate: Date;
  cancelledDays: Set<string>;
}

export function AttendanceHeatmap({ logs, trackingStartDate, endDate, cancelledDays }: AttendanceHeatmapProps) {
  const [activeTooltip, setActiveTooltip] = useState<{ date: string; status: string } | null>(null);

  const startObj = new Date(trackingStartDate);
  startObj.setDate(1);

  // Generate months from tracking start date to end date
  const months: Date[] = [];
  const currentMonth = new Date(startObj);
  while (
    currentMonth.getFullYear() < endDate.getFullYear() ||
    (currentMonth.getFullYear() === endDate.getFullYear() && currentMonth.getMonth() <= endDate.getMonth())
  ) {
    months.push(new Date(currentMonth));
    currentMonth.setMonth(currentMonth.getMonth() + 1);
  }

  const todayStr = new Date().toISOString().split("T")[0];

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {months.map((monthDate, idx) => {
          const year = monthDate.getFullYear();
          const month = monthDate.getMonth();

          const daysInMonth = new Date(year, month + 1, 0).getDate();
          const firstDayOfWeek = new Date(year, month, 1).getDay();

          const days: (string | null)[] = Array(firstDayOfWeek).fill(null);
          for (let i = 1; i <= daysInMonth; i++) {
            const dateStr = [
              year,
              String(month + 1).padStart(2, "0"),
              String(i).padStart(2, "0"),
            ].join("-");
            days.push(dateStr);
          }

          return (
            <View key={idx} style={styles.monthContainer}>
              <Text style={styles.monthLabel}>
                {monthDate.toLocaleString("default", { month: "short", year: "numeric" })}
              </Text>
              
              <View style={styles.grid}>
                {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                  <Text key={`header-${i}`} style={styles.dayHeader}>{d}</Text>
                ))}
                
                {days.map((dateStr, i) => {
                  if (!dateStr) return <View key={`empty-${i}`} style={styles.cell} />;

                  const isPreStart = dateStr < trackingStartDate;
                  const isCancelled = cancelledDays.has(dateStr);
                  const isPresent = logs.some((l) => l.verified_at.startsWith(dateStr));
                  const dObj = new Date(dateStr);
                  const isWeekend = dObj.getDay() === 0 || dObj.getDay() === 6;
                  const isFuture = dateStr > todayStr;

                  let color: string = T.colors.bg;
                  let status = "Not yet tracked";
                  let isDashed = false;

                  if (isPreStart) {
                    color = T.colors.border;
                    status = "Not yet tracked";
                  } else if (isCancelled) {
                    color = T.colors.textMuted;
                    status = "Holiday";
                  } else if (isWeekend) {
                    color = T.colors.border;
                    status = "Weekend";
                  } else if (isPresent) {
                    color = T.colors.success;
                    status = "Present";
                  } else if (!isFuture) {
                    color = T.colors.error;
                    status = "Absent";
                  } else {
                    color = T.colors.bg;
                    status = "Future";
                    isDashed = true;
                  }

                  return (
                    <Pressable
                      key={dateStr}
                      style={[
                        styles.cell,
                        { backgroundColor: color },
                        isDashed && styles.cellDashed,
                        activeTooltip?.date === dateStr && styles.cellActive
                      ]}
                      onPress={() => setActiveTooltip({ date: dateStr, status })}
                    />
                  );
                })}
              </View>
            </View>
          );
        })}
      </ScrollView>

      {/* Tooltip & Legend Area */}
      <View style={styles.footerContainer}>
        <View style={styles.legendContainer}>
          <View style={styles.legendItem}>
            <View style={[styles.legendBox, { backgroundColor: T.colors.success }]} />
            <Text style={styles.legendText}>Present</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendBox, { backgroundColor: T.colors.error }]} />
            <Text style={styles.legendText}>Absent</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendBox, { backgroundColor: T.colors.textMuted }]} />
            <Text style={styles.legendText}>Holiday</Text>
          </View>
        </View>

        <View style={styles.tooltipContainer}>
          <Text style={styles.tooltipText}>
            {activeTooltip ? `${activeTooltip.date}: ${activeTooltip.status}` : "Tap a cell for details"}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'transparent',
    padding: 0,
  },
  scrollContent: {
    paddingBottom: 8,
  },
  monthContainer: {
    marginRight: 20,
  },
  monthLabel: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
    color: T.colors.textSecondary,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 7 * 20, // 7 columns * (16 width + 4 gap)
  },
  dayHeader: {
    width: 16,
    fontSize: 10,
    textAlign: 'center',
    color: T.colors.textSecondary,
    marginRight: 4,
    marginBottom: 4,
  },
  cell: {
    width: 16,
    height: 16,
    borderRadius: 2,
    marginRight: 4,
    marginBottom: 4,
  },
  cellDashed: {
    borderWidth: 1,
    borderColor: T.colors.border,
    borderStyle: 'dashed',
  },
  cellActive: {
    borderWidth: 2,
    borderColor: T.colors.primary, // highlight for tapped cell
  },
  footerContainer: {
    marginTop: 12,
  },
  legendContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
  },
  legendBox: {
    width: 12,
    height: 12,
    borderRadius: 2,
    marginRight: 4,
  },
  legendText: {
    fontSize: 12,
    color: T.colors.textSecondary,
  },
  tooltipContainer: {
    minHeight: 20,
  },
  tooltipText: {
    fontSize: 14,
    fontWeight: '500',
    color: T.colors.text,
  }
});

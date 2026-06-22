import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"

// Create a Supabase client for direct operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

export function createAttendanceTool(db: any) {
  return createTool({
    id: "attendance_check_in_out",
    description: "Handles employee attendance check-in/check-out with AI understanding of natural language like 'present', 'here', 'checking in', 'checking out', 'leaving', etc.",
    inputSchema: z.object({
      action: z.enum(["check_in", "check_out"]).describe("The attendance action - check_in for arriving, check_out for leaving"),
      userName: z.string().describe("Full name of the user"),
      userEmail: z.string().email().describe("Email address of the user"),
      location: z.string().optional().describe("Location where the user is checking in/out from"),
      notes: z.string().optional().describe("Optional notes about the attendance"),
    }),
    execute: async ({ context }) => {
      const { action, userName, userEmail, location, notes } = context

      try {
        console.log(`🕐 Processing ${action} for ${userName} (${userEmail})`)
        
        // Find the user and get their organization
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, name, email, organization_id")
          .eq("email", userEmail)
          .single()
        
        if (userError || !user) {
          console.log(`❌ User not found: ${userEmail}`)
          return {
            success: false,
            message: `User not found with email: ${userEmail}. Please ensure you are registered in the system.`,
            action,
            userName,
            userEmail
          }
        }

        if (!user.organization_id) {
          console.log(`❌ User ${userEmail} has no organization`)
          return {
            success: false,
            message: `User ${userName} is not associated with any organization. Please contact your administrator.`,
            action,
            userName,
            userEmail
          }
        }

        console.log(`✅ Found user: ${user.name} (ID: ${user.id}) in organization: ${user.organization_id}`)

        const currentTime = new Date().toISOString()
        const currentDate = new Date().toISOString().split('T')[0] // YYYY-MM-DD format

        if (action === "check_in") {
          return await handleCheckIn(user, currentTime, currentDate, location, notes)
        } else {
          return await handleCheckOut(user, currentTime, currentDate, location, notes)
        }

      } catch (error) {
        console.error("❌ Error in attendance tool:", error)
        return {
          success: false,
          message: "An unexpected error occurred while processing attendance",
          error: error instanceof Error ? error.message : "Unknown error",
          action,
          userName,
          userEmail
        }
      }
    }
  })
}

async function handleCheckIn(user: any, currentTime: string, currentDate: string, location?: string, notes?: string) {
  console.log(`🟢 Processing check-in for ${user.name}`)

  // Check if user is already checked in today
  const { data: existingRecord, error: checkError } = await supabase
    .from("attendance_records")
    .select("*")
    .eq("user_id", user.id)
    .eq("organization_id", user.organization_id)
    .gte("check_in_time", `${currentDate}T00:00:00.000Z`)
    .lt("check_in_time", `${currentDate}T23:59:59.999Z`)
    .single()

  if (!checkError && existingRecord) {
    if (!existingRecord.check_out_time) {
      console.log(`⚠️ User ${user.name} is already checked in today`)
      return {
        success: false,
        message: `You are already checked in today at ${new Date(existingRecord.check_in_time).toLocaleTimeString()}. Please check out first if you want to update your attendance.`,
        action: "check_in",
        userName: user.name,
        userEmail: user.email,
        alreadyCheckedIn: true,
        checkInTime: existingRecord.check_in_time
      }
    }
  }

  // Get attendance policy for the organization
  const { data: policy } = await supabase
    .from("attendance_policies")
    .select("*")
    .eq("organization_id", user.organization_id)
    .single()

  // Determine status based on policy
  let status: "present" | "late" = "present"
  const checkInTime = new Date(currentTime)
  
  if (policy) {
    const expectedStartTime = new Date()
    expectedStartTime.setHours(9, 0, 0, 0) // Default 9 AM, should be configurable based on policy
    
    const lateThresholdMs = (policy.late_threshold_minutes || 15) * 60 * 1000
    const graceThresholdMs = (policy.grace_period_minutes || 5) * 60 * 1000
    
    if (checkInTime.getTime() > expectedStartTime.getTime() + graceThresholdMs) {
      status = "late"
    }
  }
  // Create attendance record
  const { data: attendanceRecord, error: createError } = await supabase
    .from("attendance_records")
    .insert({
      user_id: user.id,
      organization_id: user.organization_id,
      check_in_time: currentTime,
      status: status,
      location_address: location || null,
      location_lat: null, // Can be extended later for GPS coordinates
      location_lng: null, // Can be extended later for GPS coordinates
      notes: notes || null,
      created_at: currentTime,
      updated_at: currentTime
    })
    .select()
    .single()

  if (createError) {
    console.error("❌ Error creating attendance record:", createError)
    return {
      success: false,
      message: `Failed to record check-in: ${createError.message}`,
      action: "check_in",
      userName: user.name,
      userEmail: user.email
    }
  }

  console.log(`✅ Check-in recorded for ${user.name} with status: ${status}`)

  // Update attendance summary asynchronously
  updateAttendanceSummary(user.id, user.organization_id, currentDate, "check_in", status)
    return {
      success: true,
      message: `✅ Check-in successful! Welcome ${user.name}. Status: ${status === "late" ? "Late arrival" : "On time"}${location ? ` at ${location}` : ""}`,
      action: "check_in",
      userName: user.name,
      userEmail: user.email,
      timestamp: currentTime,
      status: status,
      location: location || null,
      recordId: attendanceRecord.id
    }
}

async function handleCheckOut(user: any, currentTime: string, currentDate: string, location?: string, notes?: string) {
  console.log(`🔴 Processing check-out for ${user.name}`)

  // Find today's attendance record
  const { data: existingRecord, error: findError } = await supabase
    .from("attendance_records")
    .select("*")
    .eq("user_id", user.id)
    .eq("organization_id", user.organization_id)
    .gte("check_in_time", `${currentDate}T00:00:00.000Z`)
    .lt("check_in_time", `${currentDate}T23:59:59.999Z`)
    .is("check_out_time", null)
    .single()

  if (findError || !existingRecord) {
    console.log(`❌ No active check-in found for ${user.name} today`)
    return {
      success: false,
      message: `No active check-in found for today. Please check in first before checking out.`,
      action: "check_out",
      userName: user.name,
      userEmail: user.email,
      noActiveCheckIn: true
    }
  }

  // Calculate work hours
  const checkInTime = new Date(existingRecord.check_in_time)
  const checkOutTime = new Date(currentTime)
  const workHours = (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60)

  // Get attendance policy to determine if it's a half day
  const { data: policy } = await supabase
    .from("attendance_policies")
    .select("*")
    .eq("organization_id", user.organization_id)
    .single()

  let updatedStatus = existingRecord.status
  if (policy && workHours < (policy.half_day_threshold_hours || 4)) {
    updatedStatus = "half_day"
  }
  // Update the attendance record with check-out time
  const { data: updatedRecord, error: updateError } = await supabase
    .from("attendance_records")
    .update({
      check_out_time: currentTime,
      total_hours: Math.round(workHours * 100) / 100, // Round to 2 decimal places
      status: updatedStatus,
      location_address: location ? `${existingRecord.location_address || ''} / ${location}`.trim() : existingRecord.location_address,
      notes: notes ? `${existingRecord.notes || ''} / ${notes}`.trim() : existingRecord.notes,
      updated_at: currentTime
    })
    .eq("id", existingRecord.id)
    .select()
    .single()

  if (updateError) {
    console.error("❌ Error updating attendance record:", updateError)
    return {
      success: false,
      message: `Failed to record check-out: ${updateError.message}`,
      action: "check_out",
      userName: user.name,
      userEmail: user.email
    }
  }

  console.log(`✅ Check-out recorded for ${user.name}, worked ${workHours.toFixed(2)} hours`)

  // Update attendance summary asynchronously
  updateAttendanceSummary(user.id, user.organization_id, currentDate, "check_out", updatedStatus, workHours)
  return {
    success: true,
    message: `✅ Check-out successful! Goodbye ${user.name}. You worked ${workHours.toFixed(2)} hours today.${updatedStatus === "half_day" ? " (Marked as half day)" : ""}${location ? ` Last location: ${location}` : ""}`,
    action: "check_out",
    userName: user.name,
    userEmail: user.email,
    timestamp: currentTime,
    work_hours: `${workHours.toFixed(2)}h`,
    status: updatedStatus,
    location: location || null,
    recordId: updatedRecord.id
  }
}

async function updateAttendanceSummary(userId: string, organizationId: string, date: string, action: string, status: string, workHours?: number) {
  try {
    const currentDate = new Date(date)
    const month = currentDate.getMonth() + 1
    const year = currentDate.getFullYear()

    console.log(`📊 Updating attendance summary for user ${userId}, month: ${month}, year: ${year}`)

    // Get or create attendance summary for this month
    const { data: existingSummary, error: summaryError } = await supabase
      .from("attendance_summary")
      .select("*")
      .eq("user_id", userId)
      .eq("organization_id", organizationId)
      .eq("month", month)
      .eq("year", year)
      .single()

    let summaryData
    if (summaryError && summaryError.message.includes("No rows found")) {
      // Create new summary record
      summaryData = {
        user_id: userId,
        organization_id: organizationId,
        month: month,
        year: year,
        total_working_days: 1,
        days_present: status === "present" ? 1 : 0,
        days_absent: 0,
        days_late: status === "late" ? 1 : 0,
        total_hours: workHours || 0,
        overtime_hours: 0,
        leave_days_taken: status === "on_leave" ? 1 : 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }

      const { error: createSummaryError } = await supabase
        .from("attendance_summary")
        .insert(summaryData)

      if (createSummaryError) {
        console.error("❌ Error creating attendance summary:", createSummaryError)
      } else {
        console.log("✅ Created new attendance summary record")
      }
    } else if (!summaryError && existingSummary) {
      // Update existing summary record
      const updateData: any = {
        updated_at: new Date().toISOString()
      }

      if (action === "check_in") {
        // Only update counts on check-in
        if (status === "present") updateData.days_present = (existingSummary.days_present || 0) + 1
        if (status === "late") updateData.days_late = (existingSummary.days_late || 0) + 1
        if (status === "on_leave") updateData.leave_days_taken = (existingSummary.leave_days_taken || 0) + 1
      } else if (action === "check_out" && workHours) {
        // Update work hours on check-out
        updateData.total_hours = (existingSummary.total_hours || 0) + workHours
        
        // Update status counts if status changed (e.g., from present to half_day)
        if (status === "half_day" && existingSummary.days_present > 0) {
          updateData.days_present = existingSummary.days_present - 1
          // Note: half_day status is tracked in attendance_records but not separately in summary
        }
      }

      const { error: updateSummaryError } = await supabase
        .from("attendance_summary")
        .update(updateData)
        .eq("id", existingSummary.id)

      if (updateSummaryError) {
        console.error("❌ Error updating attendance summary:", updateSummaryError)
      } else {
        console.log("✅ Updated attendance summary record")
      }
    }
  } catch (error) {
    console.error("❌ Error in updateAttendanceSummary:", error)
  }
}

export function createAttendanceStatusTool(db: any) {
  return createTool({
    id: "attendance_status",
    description: "Check attendance status and records for a user",
    inputSchema: z.object({
      userName: z.string().describe("Full name of the user"),
      userEmail: z.string().email().describe("Email address of the user"),
      period: z.enum(["today", "week", "month"]).optional().default("today").describe("Time period to check - today, week, or month"),
    }),
    execute: async ({ context }) => {
      const { userName, userEmail, period } = context

      try {
        console.log(`📊 Checking attendance status for ${userName} (${userEmail}) - period: ${period}`)
        
        // Find the user
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, name, email, organization_id")
          .eq("email", userEmail)
          .single()
        
        if (userError || !user) {
          return {
            success: false,
            message: `User not found with email: ${userEmail}`,
            userName,
            userEmail
          }
        }

        const currentDate = new Date()
        let startDate: string
        let endDate: string = currentDate.toISOString()

        // Calculate date range based on period
        switch (period) {
          case "today":
            startDate = currentDate.toISOString().split('T')[0] + 'T00:00:00.000Z'
            endDate = currentDate.toISOString().split('T')[0] + 'T23:59:59.999Z'
            break
          case "week":
            const weekStart = new Date(currentDate)
            weekStart.setDate(currentDate.getDate() - currentDate.getDay())
            startDate = weekStart.toISOString().split('T')[0] + 'T00:00:00.000Z'
            break
          case "month":
            const monthStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1)
            startDate = monthStart.toISOString()
            break
        }

        // Get attendance records for the period
        const { data: records, error: recordsError } = await supabase
          .from("attendance_records")
          .select("*")
          .eq("user_id", user.id)
          .eq("organization_id", user.organization_id)
          .gte("check_in_time", startDate)
          .lte("check_in_time", endDate)
          .order("check_in_time", { ascending: false })

        if (recordsError) {
          return {
            success: false,
            message: `Error fetching attendance records: ${recordsError.message}`,
            userName,
            userEmail
          }
        }

        // Process records
        const processedRecords = records?.map(record => ({
          date: new Date(record.check_in_time).toLocaleDateString(),
          checkIn: new Date(record.check_in_time).toLocaleTimeString(),
          checkOut: record.check_out_time ? new Date(record.check_out_time).toLocaleTimeString() : "Not checked out",
          workHours: record.work_hours || 0,
          status: record.status,
          location: record.location || "Not specified"
        })) || []

        // Calculate summary statistics
        const totalDays = processedRecords.length
        const totalWorkHours = processedRecords.reduce((sum, record) => sum + (record.workHours || 0), 0)
        const presentDays = processedRecords.filter(r => r.status === "present").length
        const lateDays = processedRecords.filter(r => r.status === "late").length
        const halfDays = processedRecords.filter(r => r.status === "half_day").length

        let statusMessage = ""
        if (period === "today") {
          if (totalDays === 0) {
            statusMessage = "No attendance record for today. You haven't checked in yet."
          } else {
            const todayRecord = processedRecords[0]
            statusMessage = `Today: ${todayRecord.status === "present" ? "Present" : todayRecord.status === "late" ? "Late" : todayRecord.status}. Check-in: ${todayRecord.checkIn}${todayRecord.checkOut !== "Not checked out" ? `, Check-out: ${todayRecord.checkOut}` : " (Still checked in)"}`
          }
        } else {
          statusMessage = `${period.charAt(0).toUpperCase() + period.slice(1)} summary: ${totalDays} days, ${totalWorkHours.toFixed(1)} hours worked`
        }

        return {
          success: true,
          message: statusMessage,
          userName: user.name,
          userEmail: user.email,
          period,
          totalDays,
          totalWorkHours: Math.round(totalWorkHours * 100) / 100,
          presentDays,
          lateDays,
          halfDays,
          records: processedRecords,
          summary: {
            totalDays,
            totalWorkHours: Math.round(totalWorkHours * 100) / 100,
            presentDays,
            lateDays,
            halfDays,
            averageHoursPerDay: totalDays > 0 ? Math.round((totalWorkHours / totalDays) * 100) / 100 : 0
          }
        }

      } catch (error) {
        console.error("❌ Error in attendance status tool:", error)
        return {
          success: false,
          message: "An unexpected error occurred while checking attendance status",
          error: error instanceof Error ? error.message : "Unknown error",
          userName,
          userEmail
        }
      }
    }
  })
}

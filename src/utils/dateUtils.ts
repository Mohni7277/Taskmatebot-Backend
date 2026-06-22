// Function to get the start and end dates of a week
export function getWeekDateRange(weekName: string): { startDate: string; endDate: string } {
  const now = new Date()
  const startDate = new Date(now)
  const endDate = new Date(now)

  // Reset to Sunday (start of week)
  startDate.setDate(now.getDate() - now.getDay())

  // Set to Saturday (end of week)
  endDate.setDate(startDate.getDate() + 6)

  if (weekName.toLowerCase() === "next week") {
    // Move to next week
    startDate.setDate(startDate.getDate() + 7)
    endDate.setDate(endDate.getDate() + 7)
  } else if (weekName.toLowerCase() === "last week") {
    // Move to previous week
    startDate.setDate(startDate.getDate() - 7)
    endDate.setDate(endDate.getDate() - 7)
  }
  // "this week" is the default and doesn't need adjustment

  return {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
  }
}

// Function to parse week names into dates
export function parseWeekName(weekName: string): string | null {
  const now = new Date()
  let date = new Date(now)

  const weekNameLower = weekName.toLowerCase()

  if (weekNameLower === "today") {
    // Use today's date
  } else if (weekNameLower === "tomorrow") {
    date.setDate(date.getDate() + 1)
  } else if (weekNameLower === "this week") {
    // Use Wednesday of this week (middle of week)
    const dayOfWeek = date.getDay() // 0 = Sunday, 1 = Monday, etc.
    const daysToWednesday = 3 - dayOfWeek // 3 = Wednesday
    date.setDate(date.getDate() + daysToWednesday)
  } else if (weekNameLower === "next week") {
    // Use Wednesday of next week
    const dayOfWeek = date.getDay()
    const daysToNextWednesday = 3 - dayOfWeek + 7 // 3 = Wednesday, +7 for next week
    date.setDate(date.getDate() + daysToNextWednesday)
  } else if (weekNameLower.includes("next month")) {
    // Move to the 15th of next month
    date.setMonth(date.getMonth() + 1)
    date.setDate(15)
  } else {
    // Try to parse as a date string
    try {
      const parsedDate = new Date(weekName)
      if (!isNaN(parsedDate.getTime())) {
        date = parsedDate
      } else {
        return null
      }
    } catch (e) {
      return null
    }
  }

  return formatDate(date)
}

// Helper function to format dates as YYYY-MM-DD
function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

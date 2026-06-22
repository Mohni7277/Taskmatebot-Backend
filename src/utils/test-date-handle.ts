// Test script to verify date handling

// Function to parse relative dates
function parseRelativeDate(dateText: string | number | Date) {
  // Always use the current date to ensure we get the current year
  const now = new Date()
  let date = new Date(now)

  const dateTextLower = typeof dateText === "string" ? dateText.toLowerCase() : ""

  if (dateTextLower === "today") {
    // Use today's date - no change needed
  } else if (dateTextLower === "tomorrow") {
    date.setDate(date.getDate() + 1)
  } else if (dateTextLower === "yesterday") {
    date.setDate(date.getDate() - 1)
  } else if (dateTextLower === "this week") {
    // Use Wednesday of this week (middle of week)
    const dayOfWeek = date.getDay() // 0 = Sunday, 1 = Monday, etc.
    const daysToWednesday = 3 - dayOfWeek // 3 = Wednesday
    date.setDate(date.getDate() + daysToWednesday)
  } else if (dateTextLower === "next week") {
    // Use Wednesday of next week
    const dayOfWeek = date.getDay()
    const daysToNextWednesday = 3 - dayOfWeek + 7 // 3 = Wednesday, +7 for next week
    date.setDate(date.getDate() + daysToNextWednesday)
  } else {
    // Try to parse as a date string
    try {
      // Check if it's in DD-MM-YYYY format
      const dateRegex = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/
      const match = dateTextLower.match(dateRegex)

      if (match) {
        const [_, day, month, year] = match
        const parsedYear = Number.parseInt(year)
        const currentYear = now.getFullYear()

        // If the year is very old or in the distant future, use current year
        if (parsedYear < 2000 || parsedYear > currentYear + 10) {
          date = new Date(currentYear, Number.parseInt(month) - 1, Number.parseInt(day))
        } else {
          date = new Date(parsedYear, Number.parseInt(month) - 1, Number.parseInt(day))
        }
      } else {
        // Try standard date parsing
        const parsedDate = new Date(dateText)
        if (!isNaN(parsedDate.getTime())) {
          // If the year is not specified or is very old, use current year
          if (parsedDate.getFullYear() < 2000) {
            parsedDate.setFullYear(now.getFullYear())
          }
          date = parsedDate
        } else {
          return null
        }
      }
    } catch (e) {
      console.error("Error parsing date:", e)
      return null
    }
  }

  // Format as YYYY-MM-DD
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

// Function to format dates for display
function formatTaskDate(dateString: string | number | Date | null) {
  if (!dateString) return "Not specified"

  try {
    const date = new Date(dateString)

    // Check if the date is valid
    if (isNaN(date.getTime())) {
      return "Invalid date"
    }

    // Get the current date to compare
    const now = new Date()
    const tomorrow = new Date(now)
    tomorrow.setDate(now.getDate() + 1)

    // Format the date parts
    const day = String(date.getDate()).padStart(2, "0")
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const year = date.getFullYear()

    // Get the day of week
    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    const dayOfWeek = daysOfWeek[date.getDay()]

    // Check if it's today or tomorrow
    if (date.toDateString() === now.toDateString()) {
      return `Today (${day}-${month}-${year})`
    } else if (date.toDateString() === tomorrow.toDateString()) {
      return `Tomorrow (${day}-${month}-${year})`
    } else {
      return `${dayOfWeek} (${day}-${month}-${year})`
    }
  } catch (error) {
    console.error("Error formatting date:", error)
    return dateString
  }
}

// Test with various date inputs
console.log("Current date:", new Date().toISOString())

console.log("\nTesting relative date parsing:")
console.log("'today' →", parseRelativeDate("today"))
console.log("'tomorrow' →", parseRelativeDate("tomorrow"))
console.log("'yesterday' →", parseRelativeDate("yesterday"))
console.log("'next week' →", parseRelativeDate("next week"))
console.log("'this week' →", parseRelativeDate("this week"))

console.log("\nTesting date format parsing:")
console.log("'09-11-2023' →", parseRelativeDate("09-11-2023"))
console.log("'09-11-2023' (formatted) →", formatTaskDate(parseRelativeDate("09-11-2023")))
console.log("'09/11/2023' →", parseRelativeDate("09/11/2023"))
console.log("'09.11.2023' →", parseRelativeDate("09.11.2023"))

console.log("\nTesting with current year:")
const tomorrow = parseRelativeDate("tomorrow")
console.log("Tomorrow's date:", tomorrow)
console.log("Tomorrow formatted:", formatTaskDate(tomorrow))

// Test with a specific date string that should be converted to use the current year
const oldDate = "09-11-2023"
const correctedDate = parseRelativeDate(oldDate)
console.log(`\nConverting old date '${oldDate}' to current year:`, correctedDate)
console.log("Formatted:", formatTaskDate(correctedDate))

// import { sendReminder } from '../mastra/telegramBot';
// import { createClient } from '@supabase/supabase-js';

// // Create a Supabase client for direct operations
// const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
// const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!;
// const supabase = createClient(supabaseUrl, supabaseServiceKey);

// // Check for pending reminders every minute
// const REMINDER_CHECK_INTERVAL = 60 * 1000;

// export function startReminderService() {
//   console.log('Starting reminder service');
  
//   // Check for pending reminders immediately
//   checkReminders();
  
//   // Set up interval to check for pending reminders
//   setInterval(checkReminders, REMINDER_CHECK_INTERVAL);
// }

// async function checkReminders() {
//   try {
//     // Get all pending reminders that are due
//     const now = new Date().toISOString();
//     const { data: pendingReminders, error } = await supabase
//       .from('reminders')
//       .select('*')
//       .eq('sent', false)
//       .lte('scheduled_for', now);
    
//     if (error) {
//       console.error('Error fetching reminders:', error);
//       return; // Return gracefully instead of throwing
//     }
    
//     if (!pendingReminders || pendingReminders.length === 0) {
//       return;
//     }
    
//     console.log(`Found ${pendingReminders.length} pending reminders`);
    
//     // Process each reminder
//     for (const reminder of pendingReminders) {
//       try {
//         // Send the reminder
//         await sendReminder({
//           taskId: reminder.task_id, // Adjusting field name to match database schema
//           message: reminder.message
//         });
        
//         // Mark the reminder as sent
//         const { error: updateError } = await supabase
//           .from('reminders')
//           .update({
//             sent: true,
//             sent_at: new Date().toISOString()
//           })
//           .eq('id', reminder.id);
        
//         if (updateError) {
//           console.error(`Error updating reminder ${reminder.id}:`, updateError);
//           continue; // Skip to next reminder instead of throwing
//         }
        
//         console.log(`Sent reminder ${reminder.id} for task ${reminder.task_id}`);
//       } catch (error) {
//         console.error(`Error processing reminder ${reminder.id}:`, error);
//         // Continue with next reminder instead of stopping
//       }
//     }
//   } catch (error) {
//     console.error('Error checking for reminders:', error);
//     // Function returns normally, allowing the interval to continue working
//   }
// }
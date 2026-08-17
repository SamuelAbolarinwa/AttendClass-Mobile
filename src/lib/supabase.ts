import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@env';

if (!SUPABASE_URL || SUPABASE_URL === '') {
  throw new Error(
    "BUILD ERROR: SUPABASE_URL is missing or empty. Please ensure the .env file is correctly populated during the build process."
  );
}

if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === '') {
  throw new Error(
    "BUILD ERROR: SUPABASE_ANON_KEY is missing or empty. Please ensure the .env file is correctly populated during the build process."
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false, // We use custom auth via platform_login
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

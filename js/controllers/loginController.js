// js/controllers/loginController.js
import Swal from 'sweetalert2';
import { redirectIfSession } from '../guard.js';
import { signIn } from '../services/authService.js';
import { isConfigured } from '../supabaseClient.js';
import { friendlyError, withLoading } from '../utils/helpers.js';

const form = document.getElementById('login-form');
const submit = document.getElementById('login-submit');
const errorBox = document.getElementById('login-error');

const setError = (message = '') => {
  errorBox.textContent = message;
};

async function init() {
  if (await redirectIfSession()) return;

  if (!isConfigured) {
    setError('Configura SUPABASE_URL y SUPABASE_ANON_KEY en js/supabaseClient.js.');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError();
    if (!form.reportValidity()) return;

    const email = form.email.value.trim();
    const password = form.password.value;

    await withLoading(submit, async () => {
      try {
        await signIn(email, password);
        window.location.replace('./dashboard.html');
      } catch (error) {
        if (/email not confirmed/i.test(error.message)) {
          await Swal.fire({
            icon: 'info',
            title: 'Revisa tu correo para activar tu cuenta',
            text: 'Debes confirmar tu correo electrónico antes de iniciar sesión.',
            confirmButtonText: 'Entendido'
          });
        } else {
          setError(friendlyError(error));
        }
      }
    });
  });
}

init();

// js/controllers/registerController.js
import Swal from 'sweetalert2';
import { redirectIfSession } from '../guard.js';
import { signUp } from '../services/authService.js';
import { isConfigured, supabase } from '../supabaseClient.js';
import { escapeHTML, friendlyError, withLoading } from '../utils/helpers.js';

const form = document.getElementById('register-form');
const submit = document.getElementById('register-submit');
const errorBox = document.getElementById('register-error');

const setError = (message = '') => {
  if (errorBox) errorBox.textContent = message;
};

async function init() {
  if (await redirectIfSession()) return;

  if (!isConfigured) {
    setError('Configura SUPABASE_URL y SUPABASE_ANON_KEY en js/supabaseClient.js.');
  }

  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError();
    if (!form.reportValidity()) return;

    const email = form.email.value.trim();
    const password = form.password.value;

    if (password !== form.confirm.value) {
      setError('Las contraseñas no coinciden.');
      form.confirm.focus();
      return;
    }

    await withLoading(submit, async () => {
      try {
        const { needsConfirmation } = await signUp(email, password);

        if (needsConfirmation) {
          await Swal.fire({
            icon: 'info',
            title: 'Revisa tu correo para activar tu cuenta',
            html: `Enviamos un enlace de confirmación a <strong>${escapeHTML(email)}</strong>.<br>Actívalo y luego inicia sesión.`,
            confirmButtonText: 'Ir a iniciar sesión'
          });
          window.location.replace('./login.html');
          return;
        }

        window.location.replace('./dashboard.html');
      } catch (error) {
        setError(friendlyError(error));
      }
    });
  });
}

init();
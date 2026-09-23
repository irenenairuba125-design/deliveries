import { useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './lib.js';
import { useAuth, useCart } from './state.jsx';
import Home from './pages/customer/Home.jsx';
import Restaurant from './pages/customer/Restaurant.jsx';
import Checkout from './pages/customer/Checkout.jsx';
import Orders from './pages/customer/Orders.jsx';
import Track from './pages/customer/Track.jsx';
import MerchantOrders from './pages/merchant/MerchantOrders.jsx';
import MerchantMenu from './pages/merchant/MerchantMenu.jsx';
import Driver from './pages/driver/Driver.jsx';

const HOME_FOR = { customer: '/', merchant: '/merchant', driver: '/driver' };

function RequireRole({ role, children }) {
  const { user } = useAuth();
  const loc = useLocation();
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (user.role !== role) return <Navigate to={HOME_FOR[user.role]} replace />;
  return children;
}

function Nav() {
  const { user, signOut } = useAuth();
  const { count } = useCart();
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <Link to={user ? HOME_FOR[user.role] : '/'} className="brand">
        <span>🛵</span> <span className="brand-name">Chakula</span>
        {user && user.role !== 'customer' && <span className="role-tag">{user.role}</span>}
      </Link>
      <nav>
        {(!user || user.role === 'customer') && (
          <>
            <NavLink to="/" end>Restaurants</NavLink>
            {user && <NavLink to="/orders">Orders</NavLink>}
            <NavLink to="/checkout" className="cart-link" aria-label={`Cart, ${count} items`}>
              🛒{count > 0 && <span className="count">{count}</span>}
            </NavLink>
          </>
        )}
        {user?.role === 'merchant' && (
          <>
            <NavLink to="/merchant" end>Orders</NavLink>
            <NavLink to="/merchant/menu">Menu</NavLink>
          </>
        )}
        {user ? (
          <button
            className="btn ghost small"
            onClick={() => {
              signOut();
              navigate('/login');
            }}
          >
            Sign out
          </button>
        ) : (
          <NavLink to="/login">Sign in</NavLink>
        )}
      </nav>
    </header>
  );
}

const DEMO_ACCOUNTS = [
  ['customer@demo.test', 'Customer', '🙋🏾'],
  ['merchant@demo.test', 'Restaurant', '👨🏾‍🍳'],
  ['driver@demo.test', 'Driver', '🛵'],
  ['driver2@demo.test', 'Driver 2', '🛵'],
];

function Login() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const from = useLocation().state?.from;
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', phone: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={from ?? HOME_FOR[user.role]} replace />;

  async function submit(body, path = mode === 'login' ? '/auth/login' : '/auth/register') {
    setBusy(true);
    setError('');
    try {
      const res = await api(path, { method: 'POST', body });
      signIn(res);
      navigate(res.user.role === 'customer' && from ? from : HOME_FOR[res.user.role], { replace: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const field = (k) => ({ value: form[k], onChange: (e) => setForm({ ...form, [k]: e.target.value }) });

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1>{mode === 'login' ? 'Welcome back' : 'Create an account'}</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(form);
          }}
        >
          {mode === 'register' && (
            <>
              <label>Name<input required {...field('name')} autoComplete="name" /></label>
              <label>Phone<input {...field('phone')} placeholder="0772 123456" autoComplete="tel" /></label>
            </>
          )}
          <label>Email<input type="email" required {...field('email')} autoComplete="email" /></label>
          <label>
            Password
            <input type="password" required minLength={mode === 'register' ? 8 : undefined} {...field('password')}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn primary block" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Sign up'}</button>
        </form>
        <p className="muted small center">
          {mode === 'login' ? 'New here? ' : 'Have an account? '}
          <button className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
        <div className="demo-accounts">
          <p className="muted small">Try a demo account (open each portal in a separate browser profile or window):</p>
          <div className="demo-grid">
            {DEMO_ACCOUNTS.map(([email, label, icon]) => (
              <button key={email} className="btn outline" disabled={busy}
                onClick={() => submit({ email, password: 'password123' }, '/auth/login')}>
                <span>{icon}</span> {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { ready } = useAuth();
  if (!ready) return <div className="page-loading">Loading…</div>;
  return (
    <>
      <Nav />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/r/:id" element={<Restaurant />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/orders" element={<RequireRole role="customer"><Orders /></RequireRole>} />
          <Route path="/orders/:id" element={<RequireRole role="customer"><Track /></RequireRole>} />
          <Route path="/merchant" element={<RequireRole role="merchant"><MerchantOrders /></RequireRole>} />
          <Route path="/merchant/menu" element={<RequireRole role="merchant"><MerchantMenu /></RequireRole>} />
          <Route path="/driver" element={<RequireRole role="driver"><Driver /></RequireRole>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}

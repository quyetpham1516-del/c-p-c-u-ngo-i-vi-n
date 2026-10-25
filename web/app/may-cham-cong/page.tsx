'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../src/screens/AttendanceKiosk').then((m) => m.AttendanceKiosk), { ssr: false });

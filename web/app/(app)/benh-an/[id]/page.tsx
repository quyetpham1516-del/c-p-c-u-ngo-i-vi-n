'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../../src/screens/Patients').then((m) => m.PatientDetail), { ssr: false });
